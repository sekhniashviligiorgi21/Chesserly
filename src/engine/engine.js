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
        setTimeout(() => { sf.removeEventListener('message', absorber); resolve() }, 100)
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
                sf11.onmessage = null
                sf11.postMessage('stop')
                currentResolve = null
                resolve({ evaluation, topMoves, best11 }) // best11 included in result
            }
        }

        sf.postMessage(moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")
        sf.postMessage(`go depth ${depth}`)
        if (runsf11) {
            sf11.postMessage(moves.length > 0 ? `position startpos moves ${moves.join(" ")}` : "position startpos")
            sf11.postMessage(`go depth 5`)
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
                brilliant_loss = eval_before.value - second_best_eval
            } else {
                loss = eval_after.value - eval_before.value
                brilliant_loss = second_best_eval - eval_before.value
            }
            loss = Math.max(0, loss)
        }

        let accuracy = "none"
        if (move) {
            if (isBook) {
                accuracy = "book"
            } else if (best_move === move && top_moves.length === 2 && brilliant_loss > 100 && best11 !== null  && best11 !== best_move) {
                // SF18 agrees it's the best move, the 2nd option is >150cp worse,
                // and SF11 (weaker engine) didn't find it — that's brilliant
                accuracy = "brilliant"
            } else if (best_move === move && top_moves.length === 2 && brilliant_loss > 100) {
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
        if (eval_after?.type == "mate"){
            if (eval_before?.value <= -700 || eval_before?.value >= 700){
                accuracy = "inaccuracy" 
            }
            if (eval_before?.value <= -400 || eval_before?.value >= 400){
                accuracy = "mistake"
            } 

            if (eval_before?.type === "cp") {
               accuracy = "blunder"
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
            if (eval_before?.value <= -800 && eval_after?.value <= -300 && eval_after?.value >= -600){
                accuracy = "mistake"
            }
            if (eval_before?.value <= -800 && eval_after?.value > eval_before?.value + 150 && eval_after?.value <= -600){
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
            if (eval_before?.value >= 800 && eval_after?.value >= 300 && eval_after?.value <= 600){
                accuracy = "mistake"
            }
            if (eval_before?.value >= 800 && eval_after?.value < eval_before?.value - 150 && eval_after?.value >= 600) {
                accuracy = "inaccuracy"
            }
        } 

        
        if (eval_before?.type === "mate" && eval_after?.type === "mate"){
            if (eval_before?.value > 0 && eval_after?.value < 0){
                accuracy = "blunder"
            }
            else if(eval_before?.value < 0 && eval_after?.value > 0){
                accuracy = "blunder"
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
            moves_list: afterMoves
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