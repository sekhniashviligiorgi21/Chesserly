// ... (startEngine, cancelAnalysis, and isBookMove remain unchanged)

function analyzePosition(moves, depth, onUpdate = null, runsf11 = false) {
    const myId = analysisId

    return new Promise((resolve) => {
        currentResolve = resolve
        let topMoves = [], evaluation = null, best11 = null
        const isBlackToMove = moves.length % 2 === 1

        // stockfish 11 handler
        sf11.onmessage = (i) => {
            if (analysisId !== myId) return
            const msg11 = i.data
            if (msg11.startsWith('bestmove')) {
                const m = msg11.match(/bestmove\s+(\S+)/)
                if (m) best11 = m[1]
            }
        }

        // stockfish 18 handler  
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
                // Normalize score to White's perspective
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
                    const waitForSf11 = new Promise((res) => {
                        const onSf11Stop = (i) => {
                            if (typeof i.data === 'string' && i.data.startsWith('bestmove')) {
                                // Fix race condition: Catch best11 here if main listener missed it
                                const m = i.data.match(/bestmove\s+(\S+)/)
                                if (m && !best11) best11 = m[1] 
                                
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
            sf11.postMessage(`go depth 10`)
        }
    })
}

export async function getEvaluation(move, movesList, depth, onUpdate = null) {
    const myId = analysisId

    const [isBook, before] = await Promise.all([
        isBookMove(movesList, move),
        analyzePosition(movesList, 10, null, true)
    ])

    if (analysisId !== myId || !before) return null

    const eval_before = before.evaluation
    const top_moves = before.topMoves || []
    const best11 = before.best11 ?? null
    const best_move = top_moves[0]?.Move ?? ""

    const afterMoves = move ? [...movesList, move] : movesList
    const side_to_move = afterMoves.length % 2 === 1 ? "w" : "b"

    function buildResult(eval_after, topMovesAfter, currentDepth) {
        const best_line = topMovesAfter[0]?.line ?? []
        const excellent_line = topMovesAfter[1]?.line ?? []
        const third_line = topMovesAfter[2]?.line ?? []

        let accuracy = "none"

        if (move) {
            if (isBook) {
                accuracy = "book"
            } else {
                const moverIsWhite = side_to_move === "w"

                // Extract CP values relative to the mover (Positive = Mover is winning)
                const best_eval_cp = top_moves[0]?.Centipawn ?? (eval_before?.value ?? 0)
                const second_best_cp = top_moves.length >= 2 ? (top_moves[1]?.Centipawn ?? best_eval_cp) : best_eval_cp
                
                const scoreBefore = moverIsWhite ? best_eval_cp : -best_eval_cp
                const scoreSecond = moverIsWhite ? second_best_cp : -second_best_cp
                const scoreAfter = (eval_after?.type === "cp") 
                    ? (moverIsWhite ? eval_after.value : -eval_after.value) 
                    : null
                const baselineScoreBefore = (eval_before?.type === "cp") 
                    ? (moverIsWhite ? eval_before.value : -eval_before.value) 
                    : null

                // Calculate the true gap safely within the 'before' position context
                const gap = scoreBefore - scoreSecond
                let loss = 0
                
                if (baselineScoreBefore !== null && scoreAfter !== null) {
                    loss = Math.max(0, baselineScoreBefore - scoreAfter)
                }

                const isBest = best_move === move || loss < 15
                
                // Crucial Fix: Only reward Great/Brilliant if the alternative move isn't also completely crushing.
                // If the second best move keeps you up by +4.00, finding the +6.00 move isn't brilliant, it's just normal play.
                const isSecondBestNotCrushing = scoreSecond < 400

                let isBrilliant = false
                let isGreat = false

                if (isBest && top_moves.length >= 2 && gap > 150 && isSecondBestNotCrushing) {
                    if (best11 !== null && best11 !== best_move) {
                        isBrilliant = true
                    } else {
                        isGreat = true
                    }
                }

                if (isBrilliant) accuracy = "brilliant"
                else if (isGreat) accuracy = "great"
                else if (isBest) accuracy = "best"
                else if (loss < 40) accuracy = "excellent"
                else if (loss < 80) accuracy = "good"
                else if (loss < 150) accuracy = "inaccuracy"
                else if (loss < 300) accuracy = "mistake"
                else accuracy = "blunder"

                // --- Special-case handling around forced mates & blowouts ---
                if (eval_after?.type === "mate") {
                    const moverDeliversMate = moverIsWhite ? eval_after.value > 0 : eval_after.value < 0
                    
                    if (moverDeliversMate) {
                        // Uniquely forcing mate is always decisive
                        if (best_move === move && top_moves.length >= 2 && top_moves[1]?.score?.type !== "mate") {
                            accuracy = (best11 !== null && best11 !== best_move) ? "brilliant" : "great"
                        }
                    } else if (baselineScoreBefore !== null) {
                        // Mover blundered into a mate, mitigate if they were already dead lost
                        if (baselineScoreBefore <= -700) accuracy = "inaccuracy"
                        else if (baselineScoreBefore <= -400) accuracy = "mistake"
                        else accuracy = "blunder"
                    }
                }

                // Mover went from having a forced mate to a CP evaluation
                if (eval_before?.type === "mate" && eval_after?.type === "cp") {
                    const hadMate = moverIsWhite ? eval_before.value > 0 : eval_before.value < 0
                    if (hadMate) {
                        if (scoreAfter !== null && scoreAfter >= 700) accuracy = "inaccuracy"
                        else if (scoreAfter !== null && scoreAfter >= 400) accuracy = "mistake"
                        else accuracy = "blunder"
                    }
                }

                // Adjust blunders if mover was already completely winning
                if (baselineScoreBefore !== null && scoreAfter !== null) {
                    if (baselineScoreBefore >= 800) {
                        if (scoreAfter >= 300 && scoreAfter < 600) accuracy = "mistake"
                        else if (scoreAfter >= 600 && scoreAfter < baselineScoreBefore - 150) accuracy = "inaccuracy"
                    }
                }

                // Mate to Mate transitions
                if (eval_before?.type === "mate" && eval_after?.type === "mate") {
                    const hadMate = moverIsWhite ? eval_before.value > 0 : eval_before.value < 0
                    const hasMate = moverIsWhite ? eval_after.value > 0 : eval_after.value < 0
                    if (hadMate && !hasMate) accuracy = "blunder"
                    else if (!hadMate && hasMate) accuracy = "great"
                }
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

    const afterFinal = await analyzePosition(
        afterMoves,
        depth,
        onUpdate ? (data) => onUpdate(buildResult(data.evaluation, data.topMoves, data.currentDepth)) : null
    )
    if (!afterFinal) return null

    return buildResult(afterFinal.evaluation, afterFinal.topMoves, depth)
}