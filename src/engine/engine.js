let sf = null
let analysisId = 0
let currentResolve = null
let currentMultiPV = 3

// ---- Storage Keys -----------------------------------------------------
const LOCAL_EVAL_STORAGE_KEY = 'chesserly_localEvalCache'
const MAX_CACHE_ENTRIES = 1500

// ---- Cache Dirty Flags ------------------------------------------------
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
        if (localEvalDirty) {
            saveCacheToStorage(LOCAL_EVAL_STORAGE_KEY, localEvalCache)
            localEvalDirty = false
        }
    }, PERSIST_DEBOUNCE_MS)
}

const localEvalCache = loadCacheFromStorage(LOCAL_EVAL_STORAGE_KEY)

function ensureScoreFields(score) {
    if (!score) return score
    if (!('Centipawn' in score)) {
        score.Centipawn = score.type === "cp" ? score.value : null
    }
    if (!('Mate' in score)) {
        score.Mate = score.type === "mate" ? score.value : null
    }
    return score
}

const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// ---- Local Opening Book -----------------------------------------------
let openingBookMap = new Map()
let openingBookLoaded = false

export async function loadOpeningBook(url = '/book/openings.json') {
    if (openingBookLoaded) return
    try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()

        openingBookMap = new Map()

        if (Array.isArray(data)) {
            for (const line of data) {
                if (!Array.isArray(line)) continue
                for (let i = 0; i < line.length; i++) {
                    const prefix = line.slice(0, i).join(',')
                    const mv = line[i]
                    if (!openingBookMap.has(prefix)) openingBookMap.set(prefix, new Set())
                    openingBookMap.get(prefix).add(mv)
                }
            }
        }
        else if (data && typeof data === 'object') {
            for (const [key, moves] of Object.entries(data)) {
                if (Array.isArray(moves)) openingBookMap.set(key, new Set(moves))
            }
        }

        openingBookLoaded = true
    } catch (error) {
        console.warn('Failed to load opening book:', error)
        openingBookMap = new Map()
        openingBookLoaded = true
    }
}

export function isOpeningBookLoaded() {
    return openingBookLoaded && openingBookMap.size > 0
}

export async function startEngine() {
    const bookPromise = loadOpeningBook()

    await new Promise((resolve) => {
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

    await bookPromise
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

// ---- Book Move Lookup (Local) -----------------------------------------
function isBookMove(movesList, move, hasCustomRoot = false) {
    if (hasCustomRoot) return false
    if (!openingBookLoaded || openingBookMap.size === 0) return false

    const key = movesList.join(',')
    const bookMoves = openingBookMap.get(key)
    if (!bookMoves) return false
    return bookMoves.has(move)
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
const ATTACKER_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 2 }

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

function findAttackers(board, targetRank, targetFile, attackerColor, excludeSquare = null) {
    const attackers = []
    for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
            if (excludeSquare && r === excludeSquare.rankIndex && f === excludeSquare.file) continue
            const piece = board[r][f]
            if (!piece || piece.color !== attackerColor || !ATTACKER_VALUES[piece.type]) continue
            if (pieceAttacksSquare(board, r, f, targetRank, targetFile, piece)) {
                attackers.push({ value: ATTACKER_VALUES[piece.type], type: piece.type })
            }
        }
    }
    return attackers
}

// Resolves a forced-capture sequence the way a rational player actually plays
// it: at each step, the side to move only recaptures if doing so doesn't cost
// them material overall — otherwise they decline and the exchange stops.
// This is standard SEE (Static Exchange Evaluation) minimax resolution.
function resolveExchange(targetValue, attackerValues, defenderValues) {
    if (attackerValues.length === 0) return 0
    const [attackerValue, ...restAttackers] = attackerValues
    let value = targetValue
    if (defenderValues.length > 0) {
        value -= resolveExchange(attackerValue, defenderValues, restAttackers)
    }
    return Math.max(0, value)
}

function isSacrifice(beforeFen, afterFen, move) {
    if (!afterFen || !move) return false

    const board = parseFenBoard(afterFen)
    const { rankIndex, file } = squareToIndices(move.slice(2, 4))
    const piece = board[rankIndex][file]

    if (!piece || !PIECE_VALUES[piece.type] || piece.type === 'p') return false

    let capturedValue = 0
    if (beforeFen) {
        const beforeBoard = parseFenBoard(beforeFen)
        const targetPiece = beforeBoard[rankIndex][file]
        if (targetPiece && PIECE_VALUES[targetPiece.type]) {
            capturedValue = PIECE_VALUES[targetPiece.type]
        }
    }

    const opponentColor = piece.color === 'w' ? 'b' : 'w'
    let attackers = findAttackers(board, rankIndex, file, opponentColor)
    if (attackers.length === 0) return false

    const defenders = findAttackers(board, rankIndex, file, piece.color, { rankIndex, file })

    // A king can never legally recapture into a square our remaining piece
    // still defends (it would be moving into check). Filter by piece type
    // rather than by ATTACKER_VALUES' placeholder king value, so this can't
    // silently break if that value table is ever retuned.
    if (defenders.length > 0) {
        attackers = attackers.filter(a => a.type !== 'k')
        if (attackers.length === 0) return false
    }

    attackers.sort((a, b) => a.value - b.value)
    defenders.sort((a, b) => a.value - b.value)

    const opponentBestResponse = resolveExchange(
        PIECE_VALUES[piece.type],
        attackers.map(a => a.value),
        defenders.map(d => d.value)
    )

    return (capturedValue - opponentBestResponse) < 0
}

// A move that simply captures an undefended ("hanging") piece requires no
// real calculation, so it shouldn't be flagged as a "great" find even when
// the resulting eval swing is large.
function isHangingCapture(beforeFen, move) {
    if (!beforeFen || !move) return false

    const board = parseFenBoard(beforeFen)
    const { rankIndex, file } = squareToIndices(move.slice(2, 4))
    const capturedPiece = board[rankIndex][file]

    if (!capturedPiece || !PIECE_VALUES[capturedPiece.type]) return false // not a capture

    const defenders = findAttackers(board, rankIndex, file, capturedPiece.color)
    return defenders.length === 0
}

function analyzePosition(moves, depth, onUpdate = null, multiPV = 3, rootFen = null) {
    const myId = analysisId
    const effectiveRoot = (rootFen && rootFen !== STARTPOS_FEN) ? rootFen : null

    const cacheKey = `${effectiveRoot ?? 'startpos'}|${moves.join(",")}|${depth}|${multiPV}`
    if (localEvalCache.has(cacheKey)) {
        const cachedResult = localEvalCache.get(cacheKey)
        if (cachedResult) {
            // Backfill Centipawn/Mate for old cached entries
            if (cachedResult.evaluation) ensureScoreFields(cachedResult.evaluation)
            if (cachedResult.topMoves) {
                for (const m of cachedResult.topMoves) {
                    if (m?.score) ensureScoreFields(m.score)
                }
            }
            if (onUpdate) {
                onUpdate({
                    evaluation: cachedResult.evaluation,
                    topMoves: cachedResult.topMoves,
                    currentDepth: cachedResult.currentDepth || depth
                })
            }
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

                // Add Centipawn and Mate directly to the score object so that
                // excellent_eval and third_eval (which reference .score) have them
                score.Centipawn = score.type === "cp" ? score.value : null
                score.Mate = score.type === "mate" ? score.value : null

                const info = {
                    Move: pv[1].split(" ")[0],
                    Centipawn: score.Centipawn,
                    Mate: score.Mate,
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

// ---- Brilliant Move Logic Helpers --------------------------------------
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

    if (best_move !== move) return false
    if (isBook) return false

    if (!top_moves || top_moves.length < 1) return false
    if (!top_moves[0]?.score) return false

    if (eval_before?.type !== 'cp') return false
    if (Math.abs(eval_before.value) >= 500) return false

    if (!is_sacrifice) return false

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

    if (movesList && movesList.length > 0) {
        const opponentLastMove = movesList[movesList.length - 1]
        if (opponentLastMove.slice(2, 4) === move.slice(2, 4)) return false
    }

    return true
}

export async function getEvaluation(move, movesList, depth, onUpdate = null, beforeFen = null, afterFen = null, rootFen = null, multiPV = 3) {
    const myId = analysisId
    const hasCustomRoot = !!(rootFen && rootFen !== STARTPOS_FEN)

    const beforePromise = analyzePosition(movesList, 10, null, 2, rootFen)

    const isBook = isBookMove(movesList, move, hasCustomRoot)
    const before = await beforePromise

    if (analysisId !== myId || !before) return null

    const eval_before = before.evaluation
    const top_moves = before.topMoves || []
    const best_move = top_moves[0]?.Move ?? ""

    const afterMoves = move ? [...movesList, move] : movesList

    const rootSideIsWhite = hasCustomRoot ? (rootFen.split(' ')[1] !== 'b') : true
    const side_to_move = rootSideIsWhite
        ? (afterMoves.length % 2 === 1 ? "w" : "b")
        : (afterMoves.length % 2 === 1 ? "b" : "w")

    function buildResult(eval_after, topMovesAfter, currentDepth) {
        const best_line = topMovesAfter[0]?.line ?? []
        const excellent_line = topMovesAfter[1]?.line ?? []
        const third_line = topMovesAfter[2]?.line ?? []
        let loss = 0

        if (eval_before?.type === "cp" && eval_after?.type === "cp") {
            loss = side_to_move === "w"
                ? eval_before.value - eval_after.value
                : eval_after.value - eval_before.value
            loss = Math.max(0, loss)
        }

        let accuracy = "none"
        let is_sacrifice = false

        if (move) {
            if (isBook) {
                accuracy = "book"
            } else if (best_move === move && top_moves.length >= 1) {
                is_sacrifice = isSacrifice(beforeFen, afterFen, move)

                const moverIsWhite = side_to_move === "w"
                const bestCp   = scoreToCpComparable(top_moves[0]?.score)
                const secondCp = top_moves[1] ? scoreToCpComparable(top_moves[1].score) : 0
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
                } else {
                    // Neither a simple recapture nor grabbing an already-hanging piece
                    // requires real calculation, so don't call them "great"
                    const opponentLastMove = movesList && movesList.length > 0 ? movesList[movesList.length - 1] : null
                    const isSimpleRecapture = opponentLastMove && opponentLastMove.slice(2, 4) === move.slice(2, 4)
                    const isFreeCapture = isHangingCapture(beforeFen, move)

                    const hasSecondMove = top_moves.length >= 2 && !!top_moves[1]?.score
                    if (hasSecondMove && uniquenessGap > 100 && !isSimpleRecapture && !isFreeCapture) {
                        accuracy = "great"
                    } else {
                        accuracy = "best"
                    }
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
            excellent_eval: topMovesAfter[1]?.score ?? null,
            third_eval: topMovesAfter[2]?.score ?? null,
            move_accuracy: accuracy,
            is_sacrifice,
            best_line,
            excellent_line,
            third_line,
            moves_list: afterMoves,
        }
    }

    let afterFinal = await analyzePosition(
        afterMoves,
        depth,
        onUpdate ? (data) => onUpdate(buildResult(data.evaluation, data.topMoves, data.currentDepth)) : null,
        multiPV,
        rootFen
    )

    if (!afterFinal) return null

    return buildResult(afterFinal.evaluation, afterFinal.topMoves, depth)
}