const LICHESS_TOKEN = import.meta.env.VITE_LICHESS_TOKEN

let sf = null
let sf11 = null
let analysisId = 0
let currentResolve = null
let currentMultiPV = 3  // tracks what SF18 is currently configured for, so we only send setoption when it actually changes


export async function startEngine() {
    return new Promise((resolve) => {
        sf = new Worker('/stockfish/stockfish-17.1-lite-single.js')
        sf11 = new Worker('/stockfish/stockfish.js')

        // Initialize SF18
        const onMessage = (e) => {
            const msg = e.data
            if (msg === "uciok") {
                sf.postMessage("setoption name MultiPV value 3")
                currentMultiPV = 3
                sf.postMessage("isready")
            }
            if (msg === "readyok") {
                sf.removeEventListener("message", onMessage)
                resolve()
            }
        }
        sf.addEventListener("message", onMessage)
        sf.postMessage("uci")

        // Initialize SF11 (no MultiPV needed, just best move)
        const onMessage11 = (e) => {
            const msg = e.data
            if (msg === "uciok") {
                sf11.postMessage("isready")
            }
            if (msg === "readyok") {
                sf11.removeEventListener("message", onMessage11)
                // SF11 ready, but we only resolve after SF18 is ready
            }
        }
        sf11.addEventListener("message", onMessage11)
        sf11.postMessage("uci")
    })
}

export function cancelAnalysis() {
    analysisId++

    if (currentResolve) {
        currentResolve(null)
        currentResolve = null
    }

    sf.onmessage = null
    sf11.onmessage = null

    return new Promise((resolve) => {
        const absorber = (e) => {
            if (typeof e.data === 'string' && e.data.startsWith('bestmove')) {
                sf.removeEventListener('message', absorber)
                sf11.removeEventListener('message', absorber)
                resolve()
            }
        }
        sf.addEventListener('message', absorber)
        sf.postMessage('stop')
        sf11.addEventListener('message', absorber)
        sf11.postMessage('stop')
        setTimeout(() => {
            sf.removeEventListener('message', absorber)
            sf11.removeEventListener('message', absorber)   // was missing
            resolve()
        }, 100)
    })
}

async function isBookMove(movesList, move) {
    const bookList = movesList.join(",")

    const url = bookList 
        ? `https://explorer.lichess.ovh/masters?play=${bookList}`
        : `https://explorer.lichess.ovh/masters`

    try {
        const response = await fetch(url, {
            headers: {
                // Lichess requires authentication to prevent API scraping
                'Authorization': `Bearer ${LICHESS_TOKEN}`,
                'Accept': 'application/json'
            }
        })
        if (!response.ok) return false
        
        const data = await response.json()
        return data.moves ? data.moves.some(m => m.uci === move) : false
    } catch (error) {
        console.warn("Lichess book API fetch failed:", error)
        return false
    }
}

// NEW: Lichess maintains a cloud database of positions already analyzed to high
// depth (this is how their site shows deep opening evals instantly — it's a
// lookup, not a live search). We check it before ever spinning up a local
// Stockfish search for a position. Returns the same {evaluation, topMoves,
// currentDepth} shape that analyzePosition resolves with, or null on any miss
// (no cloud data, rate-limited, network error, etc.) so callers can transparently
// fall back to local analysis.
async function getCloudEval(fen, multiPV) {
    const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPV}`

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${LICHESS_TOKEN}`,
                'Accept': 'application/json'
            }
        })
        // 404 means "not in the cloud db" — a normal, expected miss, not an error.
        if (!response.ok) return null

        const data = await response.json()
        if (!data || !Array.isArray(data.pvs) || data.pvs.length === 0) return null

        // Lichess's cloud eval is always given from White's perspective already
        // (unlike our own UCI parsing, which needs the isBlackToMove flip) — the
        // API docs specify eval/mate values are white-relative, matching how the
        // rest of this file represents `evaluation.value`.
        const topMoves = data.pvs.map((pv) => {
            const line = (pv.moves || '').split(' ').filter(Boolean)
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

        return {
            evaluation: topMoves[0]?.score ?? null,
            topMoves,
            currentDepth: data.depth ?? 0,
            best11: null
        }
    } catch (error) {
        console.warn("Lichess cloud eval fetch failed:", error)
        return null
    }
}

// OPTIMIZED: multiPV is now a parameter. The "before" search only ever needs
// best_move + second_best_eval (MultiPV 2), while the "after" search needs the
// 3 lines actually shown in the UI (MultiPV 3). Narrower MultiPV means Stockfish
// can prune more aggressively, so the before-search gets meaningfully cheaper.
function analyzePosition(moves, depth, onUpdate = null, runsf11 = false, multiPV = 3) {
    const myId = analysisId

    return new Promise((resolve) => {
        currentResolve = resolve
        let topMoves = [], evaluation = null, best11 = null
        const isBlackToMove = moves.length % 2 === 1

    //stockfish 11 handler
        sf11.onmessage = (i) => {
            if (analysisId !== myId) return
            const msg11 = i.data
            if (msg11.startsWith('bestmove')) {
                const m = msg11.match(/bestmove\s+(\S+)/)
                if (m) best11 = m[1]
            }
        }

    //stockfish 18 handler    
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
                // stockfish analyzies based on whose move it is
                // this line makes it that analysis appears from white's perspective
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
                const finish = () => {
                    sf11.onmessage = null
                    currentResolve = null
                    resolve({ evaluation, topMoves, best11 })
                }

                if (runsf11) {
                    sf11.postMessage('stop')
                    // Wait for sf11's own bestmove before handing its onmessage
                    // slot to the next analyzePosition call — otherwise a late
                    // response can land in the wrong call and clobber best11.
                    const waitForSf11 = new Promise((res) => {
                        const onSf11Stop = (i) => {
                            if (typeof i.data === 'string' && i.data.startsWith('bestmove')) {
                                sf11.removeEventListener('message', onSf11Stop)
                                res()
                            }
                        }
                        sf11.addEventListener('message', onSf11Stop)
                        setTimeout(() => {
                            sf11.removeEventListener('message', onSf11Stop)
                            res()
                        }, 100)
                    })
                    waitForSf11.then(finish)
                } else {
                    finish()
                }
            }
        }

        // OPTIMIZED: only send setoption when MultiPV actually needs to change —
        // avoids a wasted UCI round-trip on every single call when consecutive
        // calls happen to want the same value.
        if (currentMultiPV !== multiPV) {
            sf.postMessage(`setoption name MultiPV value ${multiPV}`)
            currentMultiPV = multiPV
        }

        sf.postMessage(moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")
        sf.postMessage(`go depth ${depth}`)
        if (runsf11) {
            sf11.postMessage(moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")
            sf11.postMessage(`go depth 8`)
        }
    })
}

// NEW: tries the Lichess cloud-eval cache first; only spins up a local search
// (via analyzePosition) if the cloud has no data for this exact position. The
// caller-supplied fen must match `moves` (we don't derive it ourselves here to
// avoid pulling a chess.js dependency into this module) — see call sites below.
async function analyzeWithCloudFallback(fen, moves, depth, onUpdate, runsf11, multiPV) {
    const cloud = await getCloudEval(fen, multiPV)
    if (cloud) return cloud
    return analyzePosition(moves, depth, onUpdate, runsf11, multiPV)
}

export async function getEvaluation(move, movesList, depth, onUpdate = null, beforeFen = null, afterFen = null) {
    const myId = analysisId

    // "before" position: try cloud eval first, fall back to local depth-10 search.
    // Cloud hits never need runsf11 (best11 is only used for brilliancy detection,
    // which we still compute normally against whatever eval numbers we got).
    const beforePromise = beforeFen
        ? analyzeWithCloudFallback(beforeFen, movesList, 10, null, true, 2)
        : analyzePosition(movesList, 10, null, true, 2)

    const [isBook, before] = await Promise.all([
        isBookMove(movesList, move),
        beforePromise
    ])

    if (analysisId !== myId || !before) return null

    const eval_before = before.evaluation
    const top_moves = before.topMoves || []
    const best11 = before.best11 ?? null       // SF11's best move from "before" position
    const best_move = top_moves[0]?.Move ?? ""
    const second_best_eval = top_moves.length >= 2
        ? (top_moves[1]?.Centipawn ?? 0)
        : (top_moves[0]?.Centipawn ?? 0)


    const afterMoves = move ? [...movesList, move] : movesList
    const side_to_move = afterMoves.length % 2 === 1 ? "w" : "b"

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
        if (move) {
            if (isBook) {
                accuracy = "book"
            } else if (best_move === move && top_moves.length >= 2 && brilliant_loss > 150 && best11 !== null  && best11 !== best_move) {
                // SF18 agrees it's the best move, the 2nd option is >150cp worse,
                // and SF11 (weaker engine) didn't find it — that's brilliant
                accuracy = "brilliant"
            } else if (best_move === move && top_moves.length >= 2 && brilliant_loss > 150) {
                accuracy = "great"
            } else if (best_move == move || loss < 15) {
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


        // handling accuracy in special occasions
        // --- Special-case handling around forced mate ---
        // eval_before/eval_after are always in White's perspective, so "good for the
        // mover" depends on side_to_move — a raw magnitude check isn't enough on its own.
        const moverIsWhite = side_to_move === "w"

        if (eval_after?.type === "mate") {
            const moverDeliversMate = moverIsWhite ? eval_after.value > 0 : eval_after.value < 0

            if (moverDeliversMate) {
                // Forcing mate is never worse than "best". If the 2nd-best line here
                // doesn't also force mate, this move is uniquely decisive — treat it
                // the same way a normal brilliant_loss spike would be treated.
                if (best_move === move && top_moves.length >= 2 && top_moves[1]?.score?.type !== "mate") {
                    accuracy = (best11 !== null && best11 !== best_move) ? "brilliant" : "great"
                }
            } else if (eval_before?.type === "cp") {
                // Mover blundered into getting mated. Only soften the label if they
                // were already in a heavily lost position before this move.
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
            best_line,
            excellent_line,
            third_line,
            moves_list: afterMoves,
        }
    }

    // "after" position: same cloud-first approach. Cloud eval never triggers
    // onUpdate mid-search (there's nothing incremental about a cache hit — it's
    // instant), so we call onUpdate manually once with the cloud result if we
    // got one, keeping the same "live update" contract callers already rely on.
    let afterFinal
    if (afterFen) {
        const cloud = await getCloudEval(afterFen, 3)
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
            false,
            3
        )
    }
    if (!afterFinal) return null

    return buildResult(afterFinal.evaluation, afterFinal.topMoves, depth)
}