import { Chess } from 'chess.js'

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

const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export async function startEngine() {
    return new Promise((resolve) => {
        sf = new Worker('/stockfish/stockfish-17.1-lite-single.js')

        const onMessage = (e) => {
            const msg = e.data
            if (msg === "uciok") {
                sf.postMessage("setoption name MultiPV value 3")
                currentMultiPV = 3
                // SPEED HACK: Give Stockfish 64MB of Hash memory to remember transpositions!
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

// ---- Sacrifice Detection -------------------------------------------------
// A move is treated as a "sacrifice" if, once the engine's own predicted
// continuation is played out a few plies deep, the side that made the move
// ends up down material compared to before the move — i.e. material was
// given up and hasn't (yet) come back. We can't tell this from the single
// before/after FEN alone, because a hung piece only shows up as a material
// loss once the opponent actually takes it — so we walk forward through the
// engine's own PV (which your pipeline already computes as `best_line`).
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
const SACRIFICE_MATERIAL_THRESHOLD = 2 // an exchange or more, given up for no immediate return
const SACRIFICE_SETTLE_PLIES = 6       // how far into the engine's line to walk before judging

function materialBalance(fen, moverIsWhite) {
    const board = fen.split(' ')[0]
    let white = 0, black = 0
    for (const ch of board) {
        if (ch === '/' || /\d/.test(ch)) continue
        const value = PIECE_VALUES[ch.toLowerCase()] || 0
        if (ch === ch.toUpperCase()) white += value
        else black += value
    }
    return moverIsWhite ? (white - black) : (black - white)
}

function applyLineAndGetFen(startFen, uciLine, maxPlies) {
    let chess
    try {
        chess = new Chess(startFen)
    } catch (error) {
        return startFen
    }

    for (const uci of (uciLine || []).slice(0, maxPlies)) {
        const from = uci.slice(0, 2)
        const to = uci.slice(2, 4)
        const promotion = uci.length > 4 ? uci.slice(4).toLowerCase() : undefined
        try {
            const result = chess.move({ from, to, promotion })
            if (!result) break
        } catch (error) {
            break
        }
    }
    return chess.fen()
}

function isSacrifice(beforeFen, afterFen, moverIsWhite, continuationLine) {
    if (!beforeFen || !afterFen) return false

    const balanceBefore = materialBalance(beforeFen, moverIsWhite)

    const settledFen = (continuationLine && continuationLine.length)
        ? applyLineAndGetFen(afterFen, continuationLine, SACRIFICE_SETTLE_PLIES)
        : afterFen

    const balanceAfter = materialBalance(settledFen, moverIsWhite)

    return (balanceBefore - balanceAfter) >= SACRIFICE_MATERIAL_THRESHOLD
}

async function getCloudEval(fen, multiPV) {
    if (isLichessOnCooldown()) return null

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
    const second_best_eval = top_moves.length >= 2
        ? (top_moves[1]?.Centipawn ?? 0)
        : (top_moves[0]?.Centipawn ?? 0)

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
                brilliant_loss = eval_after.value - second_best_eval
            } else {
                loss = eval_after.value - eval_before.value
                brilliant_loss = second_best_eval - eval_after.value
            }
            loss = Math.max(0, loss)
        }

        let accuracy = "none"
        let is_sacrifice = false

        if (move) {
            if (isBook) {
                accuracy = "book"
            } else if (best_move === move && top_moves.length >= 2) {
                // "Only best move" — kept from the original brilliant_loss check:
                // the played move has to be clearly ahead of every alternative.
                const isOnlyBestMove = brilliant_loss > 200

                if (isOnlyBestMove) {
                    // Brilliant now requires BOTH: it's the only good move here,
                    // AND it gives up material to get there. Being uniquely best
                    // alone just makes it "great".
                    is_sacrifice = isSacrifice(beforeFen, afterFen, side_to_move === "w", best_line)
                    accuracy = is_sacrifice ? "brilliant" : "great"
                } else if (brilliant_loss > 100) {
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
                if (best_move === move && top_moves.length >= 2 && top_moves[1]?.score?.type !== "mate") {
                    accuracy = "brilliant"
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