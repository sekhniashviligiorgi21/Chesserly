const LICHESS_TOKEN = import.meta.env.VITE_LICHESS_TOKEN

let sf = null
let sf11 = null
let analysisId = 0
let currentResolve = null


export async function startEngine() {
    return new Promise((resolve) => {
        sf = new Worker('/stockfish/stockfish-17.1-lite-single.js')
        sf11 = new Worker('/stockfish/stockfish.js')

        // Initialize SF18
        const onMessage = (e) => {
            const msg = e.data
            if (msg === "uciok") {
                sf.postMessage("setoption name MultiPV value 3")
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
            sf11.removeEventListener('message', absorber)
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

// OPTIMIZED: runsf11 is now a plain boolean flag controlled entirely by the caller.
// The "before" pass never runs SF11 anymore (see getEvaluation) — SF11 only fires
// as a targeted follow-up once we know from the "after" result that a move is even
// a brilliance candidate. This removes one full SF11 depth-8 search per move in the
// common (non-brilliant) case.
function analyzePosition(moves, depth, onUpdate = null, runsf11 = false) {
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
                const hasOnlyOneLine = mpNum === 1 && topMoves.length < 2
                const hasOnlyTwoLines = mpNum === 2 && topMoves.length < 3

                if (onUpdate && evaluation && currentDepth >= 10 && (mpNum === 3 || hasOnlyOneLine || hasOnlyTwoLines)) {
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

        sf.postMessage(moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")
        sf.postMessage(`go depth ${depth}`)
        if (runsf11) {
            sf11.postMessage(moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")
            sf11.postMessage(`go depth 8`)
        }
    })
}

// NEW: isolated SF11 follow-up search, used only when we've already determined
// (from the "after" position's own top moves) that this move is a brilliance
// candidate. Runs independently of the SF18 worker so it doesn't block on / race
// with a subsequent analyzePosition call for the next move.
function runSf11BestMove(moves) {
    const myId = analysisId

    return new Promise((resolve) => {
        let best11 = null

        const onMessage11 = (i) => {
            if (analysisId !== myId) {
                sf11.removeEventListener('message', onMessage11)
                resolve(null)
                return
            }
            const msg11 = i.data
            if (typeof msg11 === 'string' && msg11.startsWith('bestmove')) {
                const m = msg11.match(/bestmove\s+(\S+)/)
                if (m) best11 = m[1]
                sf11.removeEventListener('message', onMessage11)
                resolve(best11)
            }
        }

        sf11.addEventListener('message', onMessage11)
        sf11.postMessage(moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")
        sf11.postMessage(`go depth 8`)

        // safety net in case sf11 never emits bestmove for some reason
        setTimeout(() => {
            sf11.removeEventListener('message', onMessage11)
            resolve(best11)
        }, 1500)
    })
}

export async function getEvaluation(move, movesList, depth, onUpdate = null) {
    const myId = analysisId

    // OPTIMIZED: "before" pass no longer runs SF11 at all. It only needs SF18's
    // top moves (for best_move / second_best_eval) and book-move status.
    const [isBook, before] = await Promise.all([
        isBookMove(movesList, move),
        analyzePosition(movesList, 10, null, false)
    ])

    if (analysisId !== myId || !before) return null

    const eval_before = before.evaluation
    const top_moves = before.topMoves || []
    const best_move = top_moves[0]?.Move ?? ""
    const second_best_eval = top_moves.length >= 2
        ? (top_moves[1]?.Centipawn ?? 0)
        : (top_moves[0]?.Centipawn ?? 0)

    const afterMoves = move ? [...movesList, move] : movesList
    const side_to_move = afterMoves.length % 2 === 1 ? "w" : "b"

    // best11 is resolved lazily: null until we decide we actually need it.
    let best11 = null

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
            } else if (best_move === move && top_moves.length >= 2 && brilliant_loss > 150 && best11 !== null && best11 !== best_move) {
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

    // OPTIMIZED: "after" pass never runs SF11 either (runsf11=false always now).
    // Book moves still get this full-depth search so eval/best-line display keeps
    // working for them — only the extra SF11 pass is skipped for book moves.
    const afterFinal = await analyzePosition(
        afterMoves,
        depth,
        onUpdate ? (data) => onUpdate(buildResult(data.evaluation, data.topMoves, data.currentDepth)) : null,
        false
    )
    if (!afterFinal) return null

    // Decide, from the *after*-position result, whether this move is even a
    // brilliance candidate before ever touching SF11. Book moves never need SF11.
    let brilliant_loss_final = 0
    if (move && !isBook && eval_before?.type === "cp" && afterFinal.evaluation?.type === "cp") {
        brilliant_loss_final = side_to_move === "w"
            ? afterFinal.evaluation.value - second_best_eval
            : second_best_eval - afterFinal.evaluation.value
    }

    const isMateBrilliantCandidate =
        move && !isBook &&
        afterFinal.evaluation?.type === "mate" &&
        best_move === move &&
        top_moves.length >= 2 &&
        top_moves[1]?.score?.type !== "mate" &&
        (side_to_move === "w" ? afterFinal.evaluation.value > 0 : afterFinal.evaluation.value < 0)

    const needsSf11 =
        move && !isBook && best_move === move && top_moves.length >= 2 &&
        (brilliant_loss_final > 150 || isMateBrilliantCandidate)

    if (needsSf11) {
        best11 = await runSf11BestMove(movesList)
        if (analysisId !== myId) return null
    }

    return buildResult(afterFinal.evaluation, afterFinal.topMoves, depth)
}