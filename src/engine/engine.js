const LICHESS_TOKEN = import.meta.env.VITE_LICHESS_TOKEN

let sf = null
let analysisId = 0
let currentResolve = null
let currentMultiPV = 3

// ---- Storage Keys -----------------------------------------------------
const CLOUD_EVAL_STORAGE_KEY = 'chesserly_cloudEvalCache'
const BOOK_MOVE_STORAGE_KEY = 'chesserly_bookMoveCache'
const LOCAL_EVAL_STORAGE_KEY = 'chesserly_localEvalCache'
const MAX_CACHE_ENTRIES = 1500

// ---- Cache Dirty Flags ------------------------------------------------
let cloudEvalDirty = false
let bookMoveDirty = false
let localEvalDirty = false
let persistTimer = null
const PERSIST_DEBOUNCE_MS = 1000

function loadCacheFromStorage(storageKey) {
    try {
        const raw = localStorage.getItem(storageKey)
        if (!raw) return new Map()
        const entries = JSON.parse(raw)
        if (!Array.isArray(entries)) return new Map()
        return new Map(entries)
    } catch (error) {
        console.warn(`Failed to load ${storageKey} from localStorage:`, error)
        return new Map()
    }
}

function saveCacheToStorage(storageKey, cache) {
    try {
        if (cache.size > MAX_CACHE_ENTRIES) {
            const excess = cache.size - MAX_CACHE_ENTRIES
            const keysToDelete = Array.from(cache.keys()).slice(0, excess)
            for (const key of keysToDelete) cache.delete(key)
        }
        localStorage.setItem(storageKey, JSON.stringify(Array.from(cache.entries())))
    } catch (error) {
        console.warn(`Failed to save ${storageKey} to localStorage:`, error)
    }
}

function schedulePersist() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
        persistTimer = null
        if (cloudEvalDirty) {
            saveCacheToStorage(CLOUD_EVAL_STORAGE_KEY, cloudEvalCache)
            cloudEvalDirty = false
        }
        if (bookMoveDirty) {
            saveCacheToStorage(BOOK_MOVE_STORAGE_KEY, bookMoveCache)
            bookMoveDirty = false
        }
        if (localEvalDirty) {
            saveCacheToStorage(LOCAL_EVAL_STORAGE_KEY, localEvalCache)
            localEvalDirty = false
        }
    }, PERSIST_DEBOUNCE_MS)
}

const cloudEvalCache = loadCacheFromStorage(CLOUD_EVAL_STORAGE_KEY)
const bookMoveCache = loadCacheFromStorage(BOOK_MOVE_STORAGE_KEY)
const localEvalCache = loadCacheFromStorage(LOCAL_EVAL_STORAGE_KEY)

// ---- 429 backoff --------------------------------------------------------
const LICHESS_COOLDOWN_MS = 60_000
let lichessCooldownUntil = 0

let onRateLimited = null
export function setOnLichessRateLimited(callback) {
    onRateLimited = callback
}

function isLichessOnCooldown() {
    return Date.now() < lichessCooldownUntil
}

function enterLichessCooldown() {
    const alreadyCoolingDown = isLichessOnCooldown()
    lichessCooldownUntil = Date.now() + LICHESS_COOLDOWN_MS
    if (!alreadyCoolingDown && onRateLimited) {
        onRateLimited()
    }
}

// ---- Cloud Eval Game Disable State -------------------------------------
let cloudEvalDisabledForGame = false

/**
 * Resets the cloud eval disabled state. 
 * Call this when loading a new game to re-enable cloud eval fetches.
 */
export function resetCloudEvalState() {
    cloudEvalDisabledForGame = false
}

const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export async function startEngine() {
    return new Promise((resolve) => {
        sf = new Worker('/stockfish/stockfish-17.1-lite-single.js')

        const onMessage = (e) => {
            const msg = e.data
            if (msg === "uciok") {
                sf.postMessage("setoption name MultiPV value 3")
                currentMultiPV = 3
                sf.postMessage("setoption name Hash value 64")
                sf.postMessage("isready")
            }
            if (msg === "readyok") {
                sf.removeEventListener("message", onMessage)
                resolve()
            }
        }
        sf.addEventListener("message", onMessage)
        sf.postMessage("uci")
    })
}

export function cancelAnalysis() {
    analysisId++

    if (currentResolve) {
        currentResolve(null)
        currentResolve = null
    }

    sf.onmessage = null

    return new Promise((resolve) => {
        const absorber = (e) => {
            if (typeof e.data === 'string' && e.data.startsWith('bestmove')) {
                sf.removeEventListener('message', absorber)
                resolve()
            }
        }
        sf.addEventListener('message', absorber)
        sf.postMessage('stop')
        setTimeout(() => {
            sf.removeEventListener('message', absorber)
            resolve()
        }, 100)
    })
}

const outOfBookPrefixes = new Set()

function isPositionOutOfBook(movesList) {
    const joined = movesList.join(",")
    for (const prefix of outOfBookPrefixes) {
        if (joined === prefix || joined.startsWith(prefix + ",")) return true
    }
    return false
}

async function isBookMove(movesList, move, hasCustomRoot = false) {
    if (hasCustomRoot) return false
    if (isLichessOnCooldown()) return false
    if (isPositionOutOfBook(movesList)) return false

    const key = `${movesList.join(",")}|${move}`
    if (bookMoveCache.has(key)) {
        return bookMoveCache.get(key)
    }

    const bookList = movesList.join(",")
    const url = bookList
        ? `https://explorer.lichess.ovh/masters?play=${bookList}`
        : `https://explorer.lichess.ovh/masters`

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${LICHESS_TOKEN}`,
                'Accept': 'application/json'
            }
        })

        if (response.status === 429) {
            enterLichessCooldown()
            return false
        }

        if (!response.ok) {
            bookMoveCache.set(key, false)
            bookMoveDirty = true
            schedulePersist()
            return false
        }

        const data = await response.json()
        const result = data.moves ? data.moves.some(m => m.uci === move) : false
        bookMoveCache.set(key, result)
        bookMoveDirty = true
        schedulePersist()

        if (!result) {
            outOfBookPrefixes.add([...movesList, move].join(","))
        }

        return result
    } catch (error) {
        console.warn("Lichess book API fetch failed:", error)
        return false
    }
}

const CASTLING_UCI_960_TO_STANDARD = {
    'e1h1': 'e1g1',
    'e1a1': 'e1c1',
    'e8h8': 'e8g8',
    'e8a8': 'e8c8',
}

function normalizeCastlingUci(uci) {
    return CASTLING_UCI_960_TO_STANDARD[uci] ?? uci
}

function normalizeLine(line) {
    return line.map(normalizeCastlingUci)
}

// ---- Sacrifice Detection (Static Exchange Evaluation) -------------------
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 }
const ATTACKER_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 2 } // King is valued at 2 for attack

function parseFenBoard(fen) {
    return fen.split(' ')[0].split('/').map((row) => {
        const cells = []
        for (const ch of row) {
            if (/\d/.test(ch)) {
                for (let i = 0; i < Number(ch); i++) cells.push(null)
            } else {
                cells.push({ type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' })
            }
        }
        return cells
    })
}

function squareToIndices(square) {
    const file = square.charCodeAt(0) - 'a'.charCodeAt(0)
    const rank = Number(square[1])
    return { rankIndex: 8 - rank, file }
}

const KNIGHT_OFFSETS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
const SLIDING_DIRECTIONS = {
    b: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
    r: [[-1, 0], [1, 0], [0, -1], [0, 1]],
    q: [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]],
}

function pieceAttacksSquare(board, fromRank, fromFile, toRank, toFile, piece) {
    const dr = toRank - fromRank
    const df = toFile - fromFile

    if (piece.type === 'k') {
        return Math.abs(dr) <= 1 && Math.abs(df) <= 1 && (dr !== 0 || df !== 0)
    }

    if (piece.type === 'n') {
        return KNIGHT_OFFSETS.some(([or, of]) => or === dr && of === df)
    }

    if (piece.type === 'p') {
        const dir = piece.color === 'w' ? -1 : 1
        return dr === dir && Math.abs(df) === 1
    }

    if (SLIDING_DIRECTIONS[piece.type]) {
        for (const [dR, dF] of SLIDING_DIRECTIONS[piece.type]) {
            let r = fromRank + dR, f = fromFile + dF
            while (r >= 0 && r < 8 && f >= 0 && f < 8) {
                if (r === toRank && f === toFile) return true
                if (board[r][f]) break
                r += dR
                f += dF
            }
        }
    }

    return false
}

function findAttackerValues(board, targetRank, targetFile, attackerColor, excludeSquare = null) {
    const values = []
    for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
            if (excludeSquare && r === excludeSquare.rankIndex && f === excludeSquare.file) continue
            const piece = board[r][f]
            if (!piece || piece.color !== attackerColor || !ATTACKER_VALUES[piece.type]) continue
            if (pieceAttacksSquare(board, r, f, targetRank, targetFile, piece)) {
                values.push(ATTACKER_VALUES[piece.type])
            }
        }
    }
    return values
}

function isSacrifice(beforeFen, afterFen, move) {
    if (!afterFen || !move) return false

    const board = parseFenBoard(afterFen)
    const { rankIndex, file } = squareToIndices(move.slice(2, 4))
    const piece = board[rankIndex][file]
    
    // Exclude empty squares, kings, and pawns from being considered the sacrificed piece
    if (!piece || !PIECE_VALUES[piece.type] || piece.type === 'p') return false

    // Consider the value of the piece captured during the move
    let capturedValue = 0
    if (beforeFen) {
        const beforeBoard = parseFenBoard(beforeFen)
        const targetPiece = beforeBoard[rankIndex][file]
        // If there was an enemy piece on the square we moved to, we gain its value
        if (targetPiece && PIECE_VALUES[targetPiece.type]) {
            capturedValue = PIECE_VALUES[targetPiece.type]
        }
    }

    const opponentColor = piece.color === 'w' ? 'b' : 'w'
    let attackerValues = findAttackerValues(board, rankIndex, file, opponentColor)
    if (attackerValues.length === 0) return false // nothing attacks it — not hanging

    const defenderValues = findAttackerValues(board, rankIndex, file, piece.color, { rankIndex, file })

    // KING LOGIC FIX: 
    // If the piece is defended, the opponent's King legally cannot take it.
    if (defenderValues.length > 0) {
        attackerValues = attackerValues.filter(v => v !== 2)
    }

    // If the King was the only attacker, and it was filtered out, it's not a sacrifice.
    if (attackerValues.length === 0) return false

    // Sort attackers and defenders by value (cheapest first)
    attackerValues.sort((a, b) => a - b)
    defenderValues.sort((a, b) => a - b)

    // Simulate the capture sequence (Static Exchange Evaluation)
    let opponentGained = 0
    let weGained = capturedValue
    let turn = 'attacker' // opponent's turn to capture first
    let attackerIdx = 0
    let defenderIdx = 0
    let currentPieceValue = PIECE_VALUES[piece.type]

    while (true) {
        if (turn === 'attacker') {
            if (attackerIdx >= attackerValues.length) break
            opponentGained += currentPieceValue
            currentPieceValue = attackerValues[attackerIdx]
            attackerIdx++
            turn = 'defender'
        } else {
            if (defenderIdx >= defenderValues.length) break
            weGained += currentPieceValue
            currentPieceValue = defenderValues[defenderIdx]
            defenderIdx++
            turn = 'attacker'
        }
    }

    // If the opponent wins material by initiating the capture, it's a sacrifice.
    return opponentGained - weGained > 0
}

async function getCloudEval(fen, multiPV) {
    // Stop fetching entirely if the position has fallen out of the cloud API 
    // for the remainder of the current game.
    if (cloudEvalDisabledForGame || isLichessOnCooldown()) return null

    const cacheKey = `${fen}|${multiPV}`

    if (cloudEvalCache.has(cacheKey)) {
        return cloudEvalCache.get(cacheKey)
    }

    const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPV}`

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${LICHESS_TOKEN}`,
                'Accept': 'application/json'
            }
        })

        if (response.status === 429) {
            enterLichessCooldown()
            return null
        }

        // 404 indicates the position is not in the cloud database.
        // Disable all future cloud eval lookups for this game.
        if (response.status === 404) {
            cloudEvalDisabledForGame = true
            return null
        }

        if (!response.ok) {
            cloudEvalCache.set(cacheKey, null)
            cloudEvalDirty = true
            schedulePersist()
            return null
        }

        const data = await response.json()
        if (!data || !Array.isArray(data.pvs) || data.pvs.length === 0) {
            cloudEvalCache.set(cacheKey, null)
            cloudEvalDirty = true
            schedulePersist()
            
            // Extra fallback: if it returns ok but no PVs, treat it as out-of-cloud.
            cloudEvalDisabledForGame = true
            return null
        }

        const topMoves = data.pvs.map((pv) => {
            const line = normalizeLine((pv.moves || '').split(' ').filter(Boolean))
            const score = typeof pv.mate === 'number'
                ? { type: 'mate', value: pv.mate }
                : { type: 'cp', value: pv.cp ?? 0 }
            return {
                Move: line[0] ?? '',
                Centipawn: score.type === 'cp' ? score.value : null,
                score,
                line
            }
        })

        const result = {
            evaluation: topMoves[0]?.score ?? null,
            topMoves,
            currentDepth: data.depth ?? 0,
            best11: null
        }

        cloudEvalCache.set(cacheKey, result)
        cloudEvalDirty = true
        schedulePersist()
        return result
    } catch (error) {
        console.warn("Lichess cloud eval fetch failed:", error)
        return null
    }
}

function analyzePosition(moves, depth, onUpdate = null, multiPV = 3, rootFen = null) {
    const myId = analysisId
    const effectiveRoot = (rootFen && rootFen !== STARTPOS_FEN) ? rootFen : null

    const cacheKey = `${effectiveRoot ?? 'startpos'}|${moves.join(",")}|${depth}|${multiPV}`
    if (localEvalCache.has(cacheKey)) {
        const cachedResult = localEvalCache.get(cacheKey)
        if (onUpdate && cachedResult) {
            onUpdate({
                evaluation: cachedResult.evaluation,
                topMoves: cachedResult.topMoves,
                currentDepth: cachedResult.currentDepth || depth
            })
        }
        return Promise.resolve(cachedResult)
    }

    return new Promise((resolve) => {
        currentResolve = resolve
        let topMoves = [], evaluation = null

        const rootSideIsWhite = effectiveRoot
            ? effectiveRoot.split(' ')[1] !== 'b'
            : true
        const isBlackToMove = rootSideIsWhite
            ? (moves.length % 2 === 1)
            : (moves.length % 2 === 0)

        sf.onmessage = (e) => {
            if (analysisId !== myId) return
            const msg = e.data

            if (msg.includes("score") && msg.includes("pv")) {
                const mp = msg.match(/multipv (\d+)/)
                const depthMatch = msg.match(/\bdepth (\d+)\b/)
                const cp = msg.match(/score cp (-?\d+)/)
                const mate = msg.match(/score mate (-?\d+)/)
                const pv = msg.match(/ pv (.+)/)

                if (!pv) return

                let score = cp
                    ? { type: "cp", value: parseInt(cp[1]) }
                    : mate ? { type: "mate", value: parseInt(mate[1]) } : null

                if (!score) return
                if (isBlackToMove) score.value = -score.value

                const info = {
                    Move: pv[1].split(" ")[0],
                    Centipawn: score.type === "cp" ? score.value : null,
                    score,
                    line: pv[1].split(" ")
                }

                if (!mp || mp[1] === "1") evaluation = score
                if (mp) topMoves[parseInt(mp[1]) - 1] = info

                const mpNum = mp ? parseInt(mp[1]) : 1
                const currentDepth = depthMatch ? parseInt(depthMatch[1]) : 0
                const isLastLine = mpNum === multiPV
                const hasOnlyOneLine = mpNum === 1 && topMoves.length < 2 && multiPV >= 2
                const hasOnlyTwoLines = mpNum === 2 && topMoves.length < 3 && multiPV >= 3

                if (onUpdate && evaluation && currentDepth >= 10 && (isLastLine || hasOnlyOneLine || hasOnlyTwoLines)) {
                    onUpdate({ evaluation: { ...evaluation }, topMoves: [...topMoves], currentDepth })
                }
            }

            if (msg.startsWith("bestmove")) {
                sf.onmessage = null
                currentResolve = null

                const result = { evaluation, topMoves, best11: null, currentDepth: depth }
                localEvalCache.set(cacheKey, result)
                localEvalDirty = true
                schedulePersist()

                resolve(result)
            }
        }

        if (currentMultiPV !== multiPV) {
            sf.postMessage(`setoption name MultiPV value ${multiPV}`)
            currentMultiPV = multiPV
        }

        const posCommand = effectiveRoot
            ? (moves.length > 0 ? `position fen ${effectiveRoot} moves ${moves.join(" ")}` : `position fen ${effectiveRoot}`)
            : (moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")

        sf.postMessage(posCommand)
        sf.postMessage(`go depth ${depth}`)
    })
}

async function analyzeWithCloudFallback(fen, moves, depth, onUpdate, multiPV, rootFen = null) {
    const cloud = await getCloudEval(fen, multiPV)
    if (cloud) return cloud
    return analyzePosition(moves, depth, onUpdate, multiPV, rootFen)
}

// ---- Brilliant Move Logic Helpers --------------------------------------
/**
 * Convert a score (cp or mate) to a comparable centipawn value.
 * All scores are treated as from White's perspective (positive = White better).
 * Mate in 1 ≈ +9900, getting mated in 1 ≈ -9900, etc.
 */
function scoreToCpComparable(score) {
    if (!score) return 0
    if (score.type === 'cp') return score.value
    if (score.type === 'mate') {
        const mateIn = Math.abs(score.value)
        return score.value > 0
            ? (10000 - mateIn * 100)
            : (-10000 + mateIn * 100)
    }
    return 0
}

/**
 * Check whether a move qualifies as "brilliant" against every criterion.
 */
function checkBrilliant({
    move,
    best_move,
    top_moves,
    isBook,
    eval_before,
    eval_after,
    side_to_move,
    movesList,
    is_sacrifice,
}) {
    const moverIsWhite = side_to_move === 'w'

    // 1. Best move
    if (best_move !== move) return false

    // 3. Not an opening move
    if (isBook) return false

    if (!top_moves || top_moves.length < 2) return false
    if (!top_moves[0]?.score || !top_moves[1]?.score) return false

    // 2. Unique best (>= 180 cp gap)
    const bestCp    = scoreToCpComparable(top_moves[0].score)
    const secondCp  = scoreToCpComparable(top_moves[1].score)
    const uniquenessGap = moverIsWhite
        ? (bestCp - secondCp)
        : (secondCp - bestCp)
    if (uniquenessGap < 180) return false

    // 4. Not a forced mate already
    if (eval_before?.type === 'mate') return false

    // 5 & 6. Not already winning (+5) or losing (-5)
    if (eval_before?.type !== 'cp') return false
    if (Math.abs(eval_before.value) >= 500) return false

    // 7. Involves giving up N / B / R / Q
    if (!is_sacrifice) return false

    // 8. Opponent can legally capture it
    // (isSacrifice() verifies attackers exist & SEE favors opponent)

    // 9. Best capture doesn't ruin evaluation
    if (eval_after?.type === 'mate') {
        const moverHasMate = moverIsWhite ? eval_after.value > 0 : eval_after.value < 0
        if (!moverHasMate) return false
    } else if (eval_after?.type === 'cp') {
        if (moverIsWhite) {
            if (eval_after.value < -200) return false
            if (eval_after.value < eval_before.value - 150) return false
        } else {
            if (eval_after.value > 200) return false
            if (eval_after.value > eval_before.value + 150) return false
        }
    } else {
        return false
    }

    // 10. Improves activity / attack / king safety
    // (Implied by 2 + 7 + 9)

    // 11. Not simply recapturing
    if (movesList && movesList.length > 0) {
        const opponentLastMove = movesList[movesList.length - 1]
        if (opponentLastMove.slice(2, 4) === move.slice(2, 4)) return false
    }

    return true
}

export async function getEvaluation(move, movesList, depth, onUpdate = null, beforeFen = null, afterFen = null, rootFen = null, multiPV = 3) {
    const myId = analysisId
    const hasCustomRoot = !!(rootFen && rootFen !== STARTPOS_FEN)

    const beforePromise = beforeFen
        ? analyzeWithCloudFallback(beforeFen, movesList, 10, null, 2, rootFen)
        : analyzePosition(movesList, 10, null, 2, rootFen)

    const [isBook, before] = await Promise.all([
        isBookMove(movesList, move, hasCustomRoot),
        beforePromise
    ])

    if (analysisId !== myId || !before) return null

    const eval_before = before.evaluation
    const top_moves = before.topMoves || []
    const best_move = top_moves[0]?.Move ?? ""
    
    // Use comparable cp for uniqueness gap calculation
    const second_best_cp = top_moves.length >= 2
        ? scoreToCpComparable(top_moves[1]?.score)
        : scoreToCpComparable(top_moves[0]?.score)

    const afterMoves = move ? [...movesList, move] : movesList

    const rootSideIsWhite = hasCustomRoot ? (rootFen.split(' ')[1] !== 'b') : true
    const side_to_move = rootSideIsWhite
        ? (afterMoves.length % 2 === 1 ? "w" : "b")
        : (afterMoves.length % 2 === 1 ? "b" : "w")

    function buildResult(eval_after, topMovesAfter, currentDepth) {
        const best_line = topMovesAfter[0]?.line ?? []
        const excellent_line = topMovesAfter[1]?.line ?? []
        const third_line = topMovesAfter[2]?.line ?? []
        let loss = 0, brilliant_loss = 0

        if (eval_before?.type === "cp" && eval_after?.type === "cp") {
            if (side_to_move === "w") {
                loss = eval_before.value - eval_after.value
                brilliant_loss = eval_after.value - second_best_cp
            } else {
                loss = eval_after.value - eval_before.value
                brilliant_loss = second_best_cp - eval_after.value
            }
            loss = Math.max(0, loss)
        }

        let accuracy = "none"
        let is_sacrifice = false

        if (move) {
            if (isBook) {
                accuracy = "book"
            } else if (best_move === move && top_moves.length >= 2) {
                is_sacrifice = isSacrifice(beforeFen, afterFen, move)

                const moverIsWhite = side_to_move === "w"
                const bestCp   = scoreToCpComparable(top_moves[0]?.score)
                const secondCp = scoreToCpComparable(top_moves[1]?.score)
                const uniquenessGap = moverIsWhite
                    ? (bestCp - secondCp)
                    : (secondCp - bestCp)

                const isBrilliant = checkBrilliant({
                    move,
                    best_move,
                    top_moves,
                    isBook,
                    eval_before,
                    eval_after,
                    side_to_move,
                    movesList,
                    is_sacrifice,
                })

                if (isBrilliant) {
                    accuracy = "brilliant"
                } else if (uniquenessGap > 100) {
                    accuracy = "great"
                } else {
                    accuracy = "best"
                }
            } else if (best_move === move || loss < 15) {
                accuracy = "best"
            } else if (loss < 40) {
                accuracy = "excellent"
            } else if (loss < 80) {
                accuracy = "good"
            } else if (loss < 150) {
                accuracy = "inaccuracy"
            } else if (loss < 300) {
                accuracy = "mistake"
            } else {
                accuracy = "blunder"
            }
        }

        const moverIsWhite = side_to_move === "w"

        if (eval_after?.type === "mate") {
            const moverDeliversMate = moverIsWhite ? eval_after.value > 0 : eval_after.value < 0

            if (moverDeliversMate) {
                if (accuracy !== "brilliant" &&
                    best_move === move &&
                    topMovesAfter.length >= 2 &&
                    topMovesAfter[1]?.score?.type !== "mate") {
                    accuracy = "great"
                }
            } else if (eval_before?.type === "cp") {
                const alreadyLostBig = moverIsWhite ? eval_before.value <= -700 : eval_before.value >= 700
                const alreadyLostModerate = moverIsWhite ? eval_before.value <= -400 : eval_before.value >= 400

                if (alreadyLostBig) {
                    accuracy = "inaccuracy"
                } else if (alreadyLostModerate) {
                    accuracy = "mistake"
                } else {
                    accuracy = "blunder"
                }
            }
        }

        if (side_to_move === "b") {
            if (eval_before?.type === "mate" && eval_after?.type === "cp") {
                if (eval_before.value < 0 && eval_after.value <= -700) {
                    accuracy = "inaccuracy"
                } else if (eval_before.value < 0 && eval_after.value > -700 && eval_after.value <= -400) {
                    accuracy = "mistake"
                } else {
                    accuracy = "blunder"
                }
            }
            if (eval_before?.value <= -800 && eval_after?.value <= -300 && eval_after?.value >= -600) {
                accuracy = "mistake"
            } else if (eval_before?.value <= -800 && eval_after?.value > eval_before?.value + 150 && eval_after?.value <= -600) {
                accuracy = "inaccuracy"
            }
        }

        if (side_to_move === "w") {
            if (eval_before?.type === "mate" && eval_after?.type === "cp") {
                if (eval_before.value > 0 && eval_after.value >= 700) {
                    accuracy = "inaccuracy"
                } else if (eval_before.value > 0 && eval_after.value >= 400 && eval_after.value < 700) {
                    accuracy = "mistake"
                } else {
                    accuracy = "blunder"
                }
            }
            if (eval_before?.value >= 800 && eval_after?.value >= 300 && eval_after?.value <= 600) {
                accuracy = "mistake"
            } else if (eval_before?.value >= 800 && eval_after?.value < eval_before?.value - 150 && eval_after?.value >= 600) {
                accuracy = "inaccuracy"
            }
        }

        if (eval_before?.type === "mate" && eval_after?.type === "mate") {
            const hadMate = moverIsWhite ? eval_before.value > 0 : eval_before.value < 0
            const hasMate = moverIsWhite ? eval_after.value > 0 : eval_after.value < 0

            if (hadMate && !hasMate) {
                accuracy = "blunder"
            } else if (!hadMate && hasMate) {
                accuracy = "great"
            }
        }

        return {
            depth: currentDepth,
            move_played: move,
            best_move,
            eval: eval_after,
            excellent_eval: topMovesAfter[1]?.Centipawn ?? null,
            third_eval: topMovesAfter[2]?.Centipawn ?? null,
            move_accuracy: accuracy,
            is_sacrifice,
            best_line,
            excellent_line,
            third_line,
            moves_list: afterMoves,
        }
    }

    let afterFinal
    if (afterFen) {
        const cloud = await getCloudEval(afterFen, multiPV)
        if (analysisId !== myId) return null
        if (cloud) {
            afterFinal = cloud
            if (onUpdate) onUpdate(buildResult(cloud.evaluation, cloud.topMoves, cloud.currentDepth))
        }
    }

    if (!afterFinal) {
        afterFinal = await analyzePosition(
            afterMoves,
            depth,
            onUpdate ? (data) => onUpdate(buildResult(data.evaluation, data.topMoves, data.currentDepth)) : null,
            multiPV,
            rootFen
        )
    }
    if (!afterFinal) return null

    return buildResult(afterFinal.evaluation, afterFinal.topMoves, depth)
}