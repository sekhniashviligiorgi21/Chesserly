<script setup>
  import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
  import { Chess } from 'chess.js'
  import { TheChessboard } from 'vue3-chessboard'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { collection, query, getDocs, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
  import 'vue3-chessboard/style.css'
  import Title from "../assets/Title.vue"
  import { startEngine, getEvaluation, cancelAnalysis } from "../engine/engine.js"

  // --- Theme ---
  const currentTheme = ref(localStorage.getItem('chesslab_theme') || 'brown')
  watch(currentTheme, (newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('chesslab_theme', newTheme)
  }, { immediate: true })

  // --- Auth & Puzzle Pool ---
  const currentUser = ref(null)
  const allPuzzles = ref([])
  const puzzleQueue = ref([])
  const loading = ref(true)
  const puzzlesExhausted = ref(false)
  const solutionShown = ref(false)

  const currentPuzzle = shallowRef(null)
  const status = ref('idle') // 'idle', 'correct', 'wrong'
  const activeTab = ref('puzzle')

  // Analysis unlocks as soon as a move is made (correct or wrong) or solution is shown
  const canViewAnalysis = computed(() => status.value !== 'idle' || solutionShown.value)

  // --- Played Move Info ---
  const playedMoveSan = ref('')

  function computePlayedMoveSan() {
    if (!currentPuzzle.value?.playedMove) {
      playedMoveSan.value = ''
      return
    }
    try {
      const tempChess = new Chess(currentPuzzle.value.fen)
      const uci = currentPuzzle.value.playedMove
      const from = uci.slice(0, 2)
      let to = uci.slice(2, 4)
      const promotion = uci.length > 4 ? uci[4] : undefined

      const castlingFix = { 'e1h1': 'g1', 'e1a1': 'c1', 'e8h8': 'g8', 'e8a8': 'c8' }
      if (castlingFix[uci]) to = castlingFix[uci]

      const move = tempChess.move({ from, to, promotion })
      playedMoveSan.value = move ? move.san : ''
    } catch (e) {
      playedMoveSan.value = ''
    }
  }

  // --- Hint System ---
  const hintShown = ref(false)
  const hintUsed = ref(false)
  const hintSquare = ref(null)

  function showHint() {
    if (status.value !== 'idle') return
    hintShown.value = true
    hintUsed.value = true
    if (currentPuzzle.value?.bestMove) {
      hintSquare.value = currentPuzzle.value.bestMove.slice(0, 2)
    }
  }

  // --- Sound ---
  const soundOn = ref(localStorage.getItem('chesslab_puzzle_sound') !== 'false')
  watch(soundOn, (val) => localStorage.setItem('chesslab_puzzle_sound', String(val)))
  let audioCtx = null

  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      audioCtx = new Ctx()
    }
    if (audioCtx.state === 'suspended') audioCtx.resume()
    return audioCtx
  }

  function playSound(type) {
    if (!soundOn.value) return
    try {
      const ctx = ensureAudioCtx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      const now = ctx.currentTime

      const presets = {
        move:    { freq: 520, gain: 0.06, dur: 0.09, type: 'sine' },
        capture: { freq: 260, gain: 0.10, dur: 0.14, type: 'square' },
        check:   { freq: 880, gain: 0.10, dur: 0.20, type: 'sine' },
        correct: { freq: 660, gain: 0.10, dur: 0.30, type: 'sine' },
        wrong:   { freq: 160, gain: 0.10, dur: 0.30, type: 'square' },
      }
      const p = presets[type] ?? presets.move

      osc.type = p.type
      osc.frequency.setValueAtTime(p.freq, now)
      gain.gain.setValueAtTime(p.gain, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + p.dur)
      osc.start(now)
      osc.stop(now + p.dur + 0.02)
    } catch (e) {}
  }

  function soundForLastMove(sanMove) {
    if (chess.inCheck()) playSound('check')
    else if (sanMove?.captured) playSound('capture')
    else playSound('move')
  }

  // --- Rating Delta Popup & Animation ---
  const ratingDelta = ref(null)
  let ratingDeltaKey = 0
  const userRating = ref(Number(localStorage.getItem('chesslab_puzzle_rating')) || 1200)
  const displayRating = ref(userRating.value)

  function animateRating(target) {
    const start = displayRating.value
    const diff = target - start
    const duration = 800
    const steps = 20
    const stepTime = duration / steps
    let currentStep = 0
    const timer = setInterval(() => {
        currentStep++
        displayRating.value = Math.round(start + (diff * (currentStep / steps)))
        if (currentStep >= steps) {
            displayRating.value = target
            clearInterval(timer)
        }
    }, stepTime)
  }

  function popRatingDelta(delta) {
    ratingDeltaKey++
    const key = ratingDeltaKey
    ratingDelta.value = { value: delta, key }
    setTimeout(() => {
      if (ratingDelta.value?.key === key) ratingDelta.value = null
    }, 1200)
  }

  // Persisted Session Stats
  const savedStats = JSON.parse(localStorage.getItem('chesslab_puzzle_session') || '{"solved":0,"failed":0}')
  const sessionStats = ref(savedStats)
  const streak = ref(Number(localStorage.getItem('chesslab_puzzle_streak')) || 0)

  const boardAPI = shallowRef(null)
  const isFlipped = ref(false)

  // --- Engine & Analysis State ---
  let boardReady = false
  let engineReady = false
  const moveData = shallowRef(null)
  const isAnalyzing = ref(false)
  const currentDepth = ref(10)
  const DEPTH_STORAGE_KEY = 'chesslab_targetDepth'
  
  function loadStoredDepth() {
    const stored = Number(localStorage.getItem(DEPTH_STORAGE_KEY))
    return stored >= 10 && stored <= 30 ? stored : 15
  }
  const targetDepth = ref(loadStoredDepth())
  
  const sanLine = ref([])
  const excellentSanLine = ref([])
  const thirdSanLine = ref([])
  const bestMoveSan = ref('')
  const bestArrowSquares = ref(null)
  const height = ref(50)
  const cp = ref(0)
  const isAccuracy = ref("")
  const color = ref("")
  const lastMoveSquare = ref(null)
  const lastMoveAccuracy = ref(null)

  const chess = new Chess()
  const bestChess = new Chess()
  const greedyChess = new Chess()
  const excellentChess = new Chess()
  const thirdChess = new Chess()

  const moveTree = {
    id: 0, san: null, uci: null, fen: chess.fen(), accuracy: null, analysisData: null, parent: null, children: []
  }
  let nodeIdCounter = 1
  const nodeMap = { 0: moveTree }
  const currentNode = shallowRef(moveTree)
  const movesListUCI = ref([])
  const treeVersion = ref(0)

  onMounted(async () => {
    window.addEventListener('keydown', handleKeyDown)

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser.value = user
        await fetchRating()
        await fetchPuzzles()
      } else {
        currentUser.value = null
        allPuzzles.value = []
      }
      loading.value = false
    })

    await startEngine()
    engineReady = true
    if (currentPuzzle.value) getAccuracy()
  })

  onBeforeUnmount(async () => {
    window.removeEventListener('keydown', handleKeyDown)
    await cancelAnalysis()
  })

  watch(sessionStats, (val) => {
    localStorage.setItem('chesslab_puzzle_session', JSON.stringify(val))
  }, { deep: true })

  watch(streak, (val) => {
    localStorage.setItem('chesslab_puzzle_streak', String(val))
  })

  // --- Tree Navigation Logic ---
  const renderedMoves = computed(() => {
    treeVersion.value
    const rows = []

    function makeCell(node, moveNum, showAsStart, depth) {
      const isWhite = moveNum % 2 === 1
      return {
        key: `cell-${node.id}`,
        node,
        displayNum: Math.ceil(moveNum / 2),
        isWhite,
        showNum: isWhite || showAsStart,
        variant: depth > 0
      }
    }

    function walk(startNode, moveNum, depth = 0, isStartOfLine = true) {
      let current = startNode
      let ply = moveNum
      let firstRow = true

      if (!current.san) {
        if (current.children.length === 0) return
        walk(current.children[0], ply, depth, isStartOfLine)
        for (const variant of current.children.slice(1)) {
          walk(variant, ply, depth + 1, true)
        }
        return
      }

      while (current) {
        const mainReply = current.children[0] ?? null

        rows.push({
          key: `row-${current.id}`,
          depth,
          cells: [
            makeCell(current, ply, firstRow && isStartOfLine, depth),
            mainReply ? makeCell(mainReply, ply + 1, false, depth) : null
          ]
        })

        for (const variant of current.children.slice(1)) {
          walk(variant, ply + 1, depth + 1, true)
        }

        if (mainReply) {
          for (const variant of mainReply.children.slice(1)) {
            walk(variant, ply + 2, depth + 1, true)
          }
        }

        if (!mainReply) break
        current = mainReply.children[0] ?? null
        ply += 2
        firstRow = false
      }
    }

    walk(moveTree, 1)
    return rows
  })

  function undoMove() {
    lastMoveSquare.value = null
    lastMoveAccuracy.value = null
    if (currentNode.value.parent === null) return
    chess.undo()
    currentNode.value = currentNode.value.parent
    movesListUCI.value.pop()
    boardAPI.value.setPosition(chess.fen())
  }

  function undoMoveAndResetStatus() {
    undoMove()
    status.value = 'idle'
    activeTab.value = 'puzzle'
    if (boardAPI.value) {
      boardAPI.value.hideMoves()
      updateBoardArrows()
    }
    // BUG FIX: Recalculate engine state so the eval bar properly resets
    getAccuracy()
  }

  function redoMove() {
    lastMoveSquare.value = null
    lastMoveAccuracy.value = null
    if (currentNode.value.children.length === 0) return
    const nextNode = currentNode.value.children[0]
    let sanMove
    try { sanMove = chess.move(nextNode.uci) } catch (e) { sanMove = null }
    if (sanMove) soundForLastMove(sanMove)
    movesListUCI.value.push(nextNode.uci)
    currentNode.value = nextNode
    boardAPI.value.setPosition(nextNode.fen)
  }

  function undoAccuracy() { undoMove(); getAccuracy(); }
  function redoAccuracy() { redoMove(); getAccuracy(); }

  function jumpToNode(nodeId) {
    const node = nodeMap[nodeId]
    if (!node || node === currentNode.value) return

    const uciMoves = []
    let current = node
    while (current.parent !== null) {
      uciMoves.unshift(current.uci)
      current = current.parent
    }

    chess.load(moveTree.fen)
    for (const uci of uciMoves) {
      try { chess.move(uci) } catch (e) { console.warn("Failed to apply UCI in jumpToNode", uci, e) }
    }

    movesListUCI.value = uciMoves
    currentNode.value = node
    boardAPI.value.setPosition(node.fen)
    moveData.value = null
    isAccuracy.value = ""
    color.value = ""
    getAccuracy()
  }

  function goToStart() { jumpToNode(0) }
  function goToEnd() {
    let node = currentNode.value
    while (node.children.length > 0) node = node.children[0]
    jumpToNode(node.id)
  }

  function flipBoard() {
    if (boardAPI.value) {
      boardAPI.value.toggleOrientation()
      isFlipped.value = !isFlipped.value
    }
  }

  // Play lines functionality
  function applyUciMove(uci) {
      const from = uci.slice(0, 2)
      let to = uci.slice(2, 4)
      const promotion = uci.length > 4 ? uci[4] : undefined

      const castlingFix = { 'e1h1': 'g1', 'e1a1': 'c1', 'e8h8': 'g8', 'e8a8': 'c8' }
      if (castlingFix[uci]) to = castlingFix[uci]

      let sanMove;
      try { sanMove = chess.move({ from, to, promotion: promotion ?? undefined }) }
      catch (e) { return false }
      if (!sanMove) return false

      const normalizedUci = `${from}${to}${promotion ?? ''}`
      const existing = currentNode.value.children.find(c => c.uci === normalizedUci)
      
      if (existing) {
        currentNode.value = existing
      } else {
        const newNode = {
          id: nodeIdCounter++, san: sanMove.san, uci: normalizedUci, fen: chess.fen(), accuracy: null, parent: currentNode.value, children: []
        }
        nodeMap[newNode.id] = newNode
        currentNode.value.children.push(newNode)
        currentNode.value = newNode
        treeVersion.value++
      }

      movesListUCI.value.push(normalizedUci)
      return sanMove
  }

  function playLineMoves(uciList, count) {
      if (!uciList) return
      let lastSanMove = null
      for (let i = 0; i < count; i++) {
        const uci = uciList[i]
        if (!uci) break
        const result = applyUciMove(uci)
        if (!result) break
        lastSanMove = result
      }
      if (lastSanMove) soundForLastMove(lastSanMove)
      boardAPI.value.setPosition(chess.fen())
      treeVersion.value++
      getAccuracy()
  }

  // --- Keyboard Shortcuts ---
  function handleKeyDown(event) {
    if (event.repeat) return
    const key = event.key.toLowerCase()

    if ((key === ' ' || key === 'enter') && status.value !== 'idle') {
      event.preventDefault()
      loadRandomPuzzle()
    } else if (key === 'h' && status.value === 'idle' && !hintShown.value) {
      showHint()
    } else if (key === 's' && status.value === 'idle') {
      showSolution()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      undoAccuracy()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      redoAccuracy()
    } else if (event.key === 'Home') {
      event.preventDefault()
      goToStart()
    } else if (event.key === 'End') {
      event.preventDefault()
      goToEnd()
    }
  }

  async function fetchPuzzles() {
    if (!currentUser.value) return
    try {
      const q = query(collection(db, `users/${currentUser.value.uid}/games`))
      const snap = await getDocs(q)
      let temp = []

      snap.forEach(docSnap => {
        const data = docSnap.data()
        if (data.puzzles && Array.isArray(data.puzzles)) {
          data.puzzles.forEach((p, i) => {
            if (p.fen && p.bestMove && !p.solved) {
              temp.push({ ...p, id: `${docSnap.id}_${i}`, gameId: docSnap.id, indexInArray: i })
            }
          })
        }
      })

      allPuzzles.value = temp
      puzzlesExhausted.value = false

      if (allPuzzles.value.length > 0) {
        prepareQueue()
        loadRandomPuzzle()
      } else {
        puzzlesExhausted.value = true
      }
    } catch (e) {
      console.error("Failed to fetch puzzles:", e)
    }
  }

  function prepareQueue() {
    puzzleQueue.value = [...allPuzzles.value].sort(() => Math.random() - 0.5)
  }

  async function fetchRating() {
    if (!currentUser.value) return
    try {
      const statRef = doc(db, `users/${currentUser.value.uid}/stats/puzzle`)
      const statSnap = await getDoc(statRef)
      if (statSnap.exists()) {
        userRating.value = statSnap.data().rating || 1200
      } else {
        await setDoc(statRef, { rating: userRating.value })
      }
      displayRating.value = userRating.value
      localStorage.setItem('chesslab_puzzle_rating', String(userRating.value))
    } catch (e) {
      console.error("Failed to fetch rating:", e)
    }
  }

  async function updateRating(delta) {
    userRating.value += delta
    animateRating(userRating.value)
    localStorage.setItem('chesslab_puzzle_rating', String(userRating.value))
    if (currentUser.value) {
      try {
        const statRef = doc(db, `users/${currentUser.value.uid}/stats/puzzle`)
        await setDoc(statRef, { rating: userRating.value }, { merge: true })
      } catch (e) {
        console.error("Failed to update rating:", e)
      }
    }
  }

  function formatEval(evalObj) {
    if (chess.isGameOver()) {
      if (chess.isCheckmate()) return chess.turn() === 'w' ? '0-1' : '1-0'
      if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition() || chess.isDraw()) return '1/2-1/2'
    }
    if (!evalObj) return "0.0"
    if (evalObj.type === "cp") return (evalObj.value / 100).toFixed(2)
    if (evalObj.type === "mate") return `M${evalObj.value}`
    return ""
  }

  function evalSize() {
    if (!moveData.value || !moveData.value.eval) return
    const evalValue = moveData.value.eval.value
    const evalType = moveData.value.eval.type
    if (evalType === "mate") {
      if (evalValue >= 0) { cp.value = 800; height.value = 0 }
      else { cp.value = -800; height.value = 100 }
      return
    }
    cp.value = Math.max(-800, Math.min(800, evalValue))
    height.value = 50 - (cp.value / 800) * 50
  }

  function loadRandomPuzzle() {
    if (puzzleQueue.value.length === 0) {
      puzzlesExhausted.value = true
      currentPuzzle.value = null
      return
    }

    currentPuzzle.value = puzzleQueue.value.pop()
    computePlayedMoveSan()
    status.value = 'idle'
    solutionShown.value = false
    hintShown.value = false
    hintUsed.value = false
    hintSquare.value = null
    activeTab.value = 'puzzle'

    // Reset tree entirely for new puzzle
    chess.load(currentPuzzle.value.fen)
    moveTree.fen = currentPuzzle.value.fen
    moveTree.children = []
    moveTree.analysisData = null // Ensure stale cache isn't kept from the previous puzzle
    moveTree.accuracy = null
    nodeIdCounter = 1
    for (const key in nodeMap) {
      if (parseInt(key) !== 0) delete nodeMap[key]
    }
    currentNode.value = moveTree
    movesListUCI.value = []
    treeVersion.value++

    if (boardAPI.value) {
      const shouldBeFlipped = currentPuzzle.value.turn === 'black'
      if (shouldBeFlipped !== isFlipped.value) {
        boardAPI.value.toggleOrientation()
        isFlipped.value = shouldBeFlipped
      }
      boardAPI.value.setPosition(currentPuzzle.value.fen)
      boardAPI.value.hideMoves()
      
      // Delay board arrows slightly to ensure board has rendered the new FEN first
      setTimeout(() => {
        updateBoardArrows()
      }, 50)
    }

    getAccuracy()
  }

  function onBoardCreated(api) {
    boardAPI.value = api
    boardReady = true
    if (currentPuzzle.value) {
      nextTick(() => {
        const shouldBeFlipped = currentPuzzle.value.turn === 'black'
        if (shouldBeFlipped !== isFlipped.value) {
          boardAPI.value.toggleOrientation()
          isFlipped.value = shouldBeFlipped
        }
        boardAPI.value.setPosition(currentPuzzle.value.fen)
        updateBoardArrows()
      })
    }
  }

  async function handleBothMoves(move) {
    if (!currentPuzzle.value) {
      boardAPI.value.setPosition(currentNode.value.fen)
      return
    }

    if (boardAPI.value) {
      boardAPI.value.hideMoves()
      updateBoardArrows()
    }
    hintSquare.value = null 

    const uci = move.promotion ? `${move.from}${move.to}${move.promotion}` : `${move.from}${move.to}`
    let sanMove
    try {
      sanMove = chess.move({ from: move.from, to: move.to, promotion: move.promotion ?? undefined })
    } catch (e) {
      sanMove = null
    }

    if (!sanMove) {
      boardAPI.value.setPosition(currentNode.value.fen)
      return
    }

    soundForLastMove(sanMove)

    const existing = currentNode.value.children.find(c => c.uci === uci)
    if (existing) {
      currentNode.value = existing
    } else {
      const newNode = {
        id: nodeIdCounter++, san: sanMove.san, uci, fen: chess.fen(), accuracy: null, analysisData: null, parent: currentNode.value, children: []
      }
      nodeMap[newNode.id] = newNode
      currentNode.value.children.push(newNode)
      currentNode.value = newNode
      treeVersion.value++
    }

    movesListUCI.value.push(uci)
    
    // Only check the puzzle solution if the puzzle hasn't been completed yet ('idle')
    const shouldCheckSolution = (status.value === 'idle')
    await getAccuracy(shouldCheckSolution)
  }

  async function getAccuracy(checkSolution = false) {
    await cancelAnalysis()

    const cached = currentNode.value.analysisData
    const requiresMultiPV3 = true
    const hasRequiredMultiPV = !requiresMultiPV3 || !currentNode.value.san || (cached?.topMoves?.length >= 3)

    if (cached && cached.depth >= targetDepth.value && hasRequiredMultiPV) {
      moveData.value = cached
      lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
      lastMoveAccuracy.value = cached.move_accuracy
      currentDepth.value = cached.depth
      isAnalyzing.value = false
      if (boardAPI.value) boardAPI.value.hideMoves()
      
      evalSize()
      moveDescription()
      sanBest()
      uciSecondLine()
      uciThirdLine()
      uciLine()
      updateBoardArrows()
      
      if (checkSolution) checkPuzzleSolution()
      return
    }

    if (cached && !hasRequiredMultiPV) {
      moveData.value = cached
      lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
      lastMoveAccuracy.value = cached.move_accuracy
      currentDepth.value = cached.depth
      
      evalSize()
      moveDescription()
      sanBest()
      uciSecondLine()
      uciThirdLine()
      uciLine()
      updateBoardArrows()
    }

    isAnalyzing.value = true
    bestArrowSquares.value = null
    if (boardAPI.value) {
      boardAPI.value.hideMoves()
      updateBoardArrows()
    }

    const beforeFen = currentNode.value.parent ? currentNode.value.parent.fen : moveTree.fen
    const afterFen = currentNode.value.fen

    await getEvaluation(
      movesListUCI.value.length === 0 ? '' : movesListUCI.value.at(-1),
      movesListUCI.value.slice(0, -1),
      targetDepth.value,
      (result) => {
        moveData.value = result
        lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
        lastMoveAccuracy.value = result.move_accuracy
        
        currentNode.value.accuracy = result.move_accuracy
        currentNode.value.analysisData = result
        currentDepth.value = result.depth
        isAnalyzing.value = false

        evalSize()
        moveDescription()
        sanBest()
        uciLine()
        uciSecondLine()
        uciThirdLine()
        updateBoardArrows()

        treeVersion.value++

        if (checkSolution) checkPuzzleSolution()
      },
      beforeFen,
      afterFen,
      moveTree.fen,
      3
    )
  }

  function checkPuzzleSolution() {
    if (status.value !== 'idle') return 
    
    const acc = moveData.value?.move_accuracy
    const playedUci = currentNode.value.uci
    const dbBestMove = currentPuzzle.value.bestMove

    // BUG FIX: Normalize engine castling targets to match standard board UCI
    const castlingFix = { 'e1h1': 'e1g1', 'e1a1': 'e1c1', 'e8h8': 'e8g8', 'e8a8': 'e8c8' }
    const normalizedDbBestMove = castlingFix[dbBestMove] || dbBestMove

    if (['brilliant', 'great', 'best', 'excellent'].includes(acc) || playedUci === normalizedDbBestMove) {
      streak.value += 1
      const basePoints = hintUsed.value ? 8 : 15
      const streakBonus = hintUsed.value ? 0 : (streak.value - 1) * 2
      const totalPoints = basePoints + streakBonus

      status.value = 'correct'
      sessionStats.value.solved++
      updateRating(totalPoints)
      popRatingDelta(totalPoints)
      playSound('correct')
      
      if (currentUser.value && currentPuzzle.value.gameId && currentPuzzle.value.indexInArray !== undefined) {
        updateDoc(doc(db, `users/${currentUser.value.uid}/games`, currentPuzzle.value.gameId), {
          [`puzzles.${currentPuzzle.value.indexInArray}.solved`]: true
        }).catch(e => console.error("Failed to mark puzzle as solved:", e))
      }
    } else {
      streak.value = 0
      updateRating(-10)
      popRatingDelta(-10)
      playSound('wrong')
      sessionStats.value.failed++
      status.value = 'wrong'
    }
  }

  function showSolution() {
    if (status.value === 'idle') {
      streak.value = 0
      updateRating(-10)
      popRatingDelta(-10)
      sessionStats.value.failed++
      status.value = 'wrong'
    }
    solutionShown.value = true

    if (boardAPI.value && currentPuzzle.value) {
      const bestUci = currentPuzzle.value.bestMove
      const from = bestUci.slice(0, 2)
      let to = bestUci.slice(2, 4) // Changed to let
      const promotion = bestUci.length > 4 ? bestUci[4] : undefined
      
      // BUG FIX: Translate castling coordinates so chess.js doesn't crash
      const castlingFix = { 'e1h1': 'g1', 'e1a1': 'c1', 'e8h8': 'g8', 'e8a8': 'c8' }
      if (castlingFix[bestUci]) to = castlingFix[bestUci]

      let sanMove = null
      try {
        sanMove = chess.move({ from, to, promotion })
      } catch(e) {}

      if (sanMove) {
        const existing = currentNode.value.children.find(c => c.uci === bestUci)
        if (existing) {
          currentNode.value = existing
        } else {
          const newNode = {
            id: nodeIdCounter++, san: sanMove.san, uci: bestUci, fen: chess.fen(), accuracy: null, analysisData: null, parent: currentNode.value, children: []
          }
          nodeMap[newNode.id] = newNode
          currentNode.value.children.push(newNode)
          currentNode.value = newNode
          treeVersion.value++
        }
        movesListUCI.value.push(bestUci)
        boardAPI.value.setPosition(chess.fen())
        getAccuracy()
      }
    }
    activeTab.value = 'analysis'
  }

  function updateBoardArrows() {
    if (!boardAPI.value) return
    const shapes = []

    if (status.value !== 'idle' && bestArrowSquares.value) {
      shapes.push({ orig: bestArrowSquares.value.from, dest: bestArrowSquares.value.to, brush: 'green' })
    }

    boardAPI.value.setShapes(shapes)
  }

  function uciLine() {
    sanLine.value = []
    bestArrowSquares.value = null
    if (!moveData.value?.best_line) return
    let lineNum = 0
    greedyChess.load(chess.fen())
    for (let i = 0; i < 30; i++) {
      const greedyMoveBefore = moveData.value.best_line[lineNum]
      if (!greedyMoveBefore) break
      const greedyMove = greedyChess.move(greedyMoveBefore, { sloppy: true })
      if (!greedyMove) break
      sanLine.value.push(greedyMove.san)
      if (lineNum === 0) bestArrowSquares.value = { from: greedyMove.from, to: greedyMove.to }
      lineNum++
    }
  }

  function uciSecondLine() {
    if (!moveData.value?.excellent_line) return
    excellentSanLine.value = []
    let secondLineNum = 0
    excellentChess.load(chess.fen())
    for (let i = 0; i < 30; i++) {
      const excellentMoveBefore = moveData.value.excellent_line[secondLineNum]
      if (!excellentMoveBefore) break
      const excellentMove = excellentChess.move(excellentMoveBefore, { sloppy: true })
      if (!excellentMove) break
      excellentSanLine.value.push(excellentMove.san)
      secondLineNum++
    }
  }

  function uciThirdLine() {
    if (!moveData.value?.third_line) return
    thirdSanLine.value = []
    let thirdLineNum = 0
    thirdChess.load(chess.fen())
    for (let i = 0; i < 30; i++) {
      const thirdMoveBefore = moveData.value.third_line[thirdLineNum]
      if (!thirdMoveBefore) break
      const thirdMove = thirdChess.move(thirdMoveBefore, { sloppy: true })
      if (!thirdMove) break
      thirdSanLine.value.push(thirdMove.san)
      thirdLineNum++
    }
  }

  function sanBest() {
    if (!moveData.value?.best_move) return
    const baseFen = currentNode.value.parent ? currentNode.value.parent.fen : moveTree.fen
    bestChess.load(baseFen)
    const bestMoveBefore = moveData.value.best_move
    const bestMove = bestChess.move(bestMoveBefore, { sloppy: true })
    if (!bestMove) return
    bestMoveSan.value = bestMove.san
  }

  function prettyMove(move) {
    const pieces = { 'K': '♚', 'Q': '♛', 'R': '♜', 'B': '♝', 'N': '♞' }
    return move ? move.replace(/[KQRBN]/g, p => pieces[p]) : ''
  }

  function accuracySymbol(acc) {
    if (acc === "brilliant") return '/moveClassifications/brilliant.png'
    if (acc === "best") return '/moveClassifications/best.png'
    if (acc === "excellent") return '/moveClassifications/excellent.png'
    if (acc === "good") return '/moveClassifications/good.png'
    if (acc === "inaccuracy") return '/moveClassifications/inaccuracy.png'
    if (acc === "mistake") return '/moveClassifications/mistake.png'
    if (acc === "blunder") return '/moveClassifications/blunder.png'
    if (acc === "great") return '/moveClassifications/great.png'
    if (acc === "book") return '/moveClassifications/book.png'
    return ''
  }

  function moveDescription() {
    isAccuracy.value = ''
    if (!currentNode.value.san) return
    const descriptions = {
      great:      { color: '#4c8cb5',  text: ' is a great move!'},
      brilliant:  { color: '#03aea7', text: ' is a brilliant move!!' },
      book:       { color: '#ad8760', text: ' is a book move' },
      best:       { color: '#6ad13f', text: ' is the best move' },
      excellent:  { color: '#90bc36', text: ' is an excellent move' },
      good:       { color: '#8eae83', text: ' is a good move' },
      inaccuracy: { color: '#f2bc43', text: ' is an inaccuracy' },
      mistake:    { color: '#f38800', text: ' is a mistake' },
      blunder:    { color: '#FF0000', text: ' is a blunder' },
    }
    const config = descriptions[moveData.value?.move_accuracy]
    if (!config) return
    color.value = config.color
    isAccuracy.value = prettyMove(currentNode.value.san) + config.text
  }

  function displayBest() {
    if (!moveData.value) return ""
    if (['brilliant', 'best', 'great', 'book'].includes(moveData.value.move_accuracy)) return ""
    if (moveData.value.best_move === "") return ""
    return prettyMove(bestMoveSan.value) + " was the best"
  }

  function squareStyle(square) {
    if (!square) return {}
    const file = square.charCodeAt(0) - 97
    const rank = parseInt(square[1]) - 1
    const flipped = isFlipped.value
    const col = flipped ? 7 - file : file
    const row = flipped ? rank : 7 - rank
    return {
      position: 'absolute',
      left: `${col * 12.5}%`,
      top: `${row * 12.5}%`,
      width: '12.5%',
      height: '12.5%',
      zIndex: 15,
      pointerEvents: 'none',
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }

  function accuracyIconStyle(square) {
    if (!square) return {}
    const file = square.charCodeAt(0) - 97
    const rank = parseInt(square[1]) - 1
    const flipped = isFlipped.value
    const col = flipped ? 7 - file : file
    const row = flipped ? rank : 7 - rank
    return {
      position: 'absolute',
      left: `${(col + 1) * 12.5}%`,
      top: `${row * 12.5}%`,
      transform: 'translate(-70%, -35%)',
    }
  }
</script>

<template>
  <div class="grid-layout">
    <Title class="title-slot" />

    <!-- Empty States & Loaders -->
    <div v-if="loading" class="empty-state">
      <div class="loading-spinner"><div class="spinner-ring"></div><div class="spinner-ring"></div><div class="spinner-ring"></div></div>
      <p>Loading your puzzles...</p>
    </div>

    <div v-else-if="!currentUser" class="empty-state">
      <h2>Log In Required</h2>
      <p>Please log in from the top right to access and track your puzzles.</p>
    </div>

    <div v-else-if="puzzlesExhausted" class="empty-state exhausted-state">
      <div class="trophy-icon">🏆</div>
      <h2>All Caught Up!</h2>
      <p>You have successfully solved all the available puzzles generated from your games.</p>
      <div class="exhausted-actions">
        <router-link to="/Review" class="tool-btn primary">Import & Analyze a Game</router-link>
      </div>
      <p class="muted">Chesserly automatically creates puzzles based on mistakes you make in your imported games.</p>
    </div>

    <!-- Main Puzzle Layout -->
    <template v-else>
      <div class="board-area">
        <div class="board-wrapper">
          <div class="player-bar">
            <span class="player-color-dot" :class="currentPuzzle?.turn"></span>
            <span class="player-name">{{ currentPuzzle?.turn === 'white' ? 'White to Play' : 'Black to Play' }}</span>
          </div>

          <div class="board-row">
            <div class="evalbar" :class="{ 'is-visible': canViewAnalysis }">
              <div class="evalbar-inner">
                <template v-if="!isFlipped">
                  <div class="blackeval" :style="{ height: height + '%', borderRadius: '10px 10px 0 0' }"></div>
                  <div class="whiteeval" :style="{ height: (100 - height) + '%', borderRadius: '0 0 10px 10px' }"></div>
                </template>
                <template v-else>
                  <div class="whiteeval" :style="{ height: (100 - height) + '%', borderRadius: '10px 10px 0 0' }"></div>
                  <div class="blackeval" :style="{ height: height + '%', borderRadius: '0 0 10px 10px' }"></div>
                </template>
              </div>
              <p class="evalnum">{{ formatEval(moveData?.eval) }}</p>
            </div>

            <div class="board-col">
              <TheChessboard
                class="game-board"
                @move="handleBothMoves"
                @board-created="onBoardCreated"
                :board-config="{ coordinates: true, animation: { enabled: false } }"
              />

              <!-- Status or Move Classification Icon -->
              <svg v-if="status === 'correct' && lastMoveSquare" class="board-acc-icon status-icon" viewBox="0 0 24 24" :style="accuracyIconStyle(lastMoveSquare)">
                 <circle cx="12" cy="12" r="10" fill="#6ad13f" />
                 <path d="M7 13l3 3 7-7" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />
              </svg>
              
              <svg v-else-if="status === 'wrong' && lastMoveSquare" class="board-acc-icon status-icon" viewBox="0 0 24 24" :style="accuracyIconStyle(lastMoveSquare)">
                 <circle cx="12" cy="12" r="10" fill="#ff4c4c" />
                 <path d="M8 8l8 8M16 8l-8 8" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none" />
              </svg>

              <img
                v-else-if="lastMoveSquare && lastMoveAccuracy && canViewAnalysis"
                :src="accuracySymbol(lastMoveAccuracy)"
                class="board-acc-icon"
                :style="accuracyIconStyle(lastMoveSquare)"
              />
              
              <!-- Hint Highlight Circle -->
              <div v-if="hintSquare" :style="squareStyle(hintSquare)" class="hint-overlay">
                <div class="hint-circle"></div>
              </div>
            </div>
          </div>

          <div class="player-bar bottom">
            <span class="player-color-dot" :class="currentPuzzle?.turn === 'white' ? 'black' : 'white'"></span>
            <span class="player-name">Your Past Self</span>
          </div>

          <!-- Board Tools (Navigation) -->
          <div class="boardtools" v-if="canViewAnalysis">
            <button class="jumpstart" @click="goToStart" :disabled="currentNode.parent === null" title="Jump to start"><<</button>
            <button class="undo" @click="undoAccuracy" title="previous" :disabled="currentNode.parent === null"><-</button>
            <button class="reverse" @click="flipBoard" title="flip board">↳↰</button>
            <button class="redo" title="next" @click="redoAccuracy" :disabled="currentNode.children.length === 0">-></button>
            <button class="jumpend" @click="goToEnd" :disabled="currentNode.children.length === 0" title="Jump to end">>></button>
          </div>
        </div>
      </div>

      <!-- Right Sidebar -->
      <div class="puzzle-sidebar">
        <!-- Tabs -->
        <div class="tabs-container">
          <button class="tab-btn" :class="{ active: activeTab === 'puzzle' }" @click="activeTab = 'puzzle'">
            Puzzle
          </button>
          <button 
            class="tab-btn" 
            :class="{ active: activeTab === 'analysis' }" 
            :disabled="!canViewAnalysis"
            @click="canViewAnalysis && (activeTab = 'analysis')"
          >
            Analysis
          </button>
        </div>

        <!-- Puzzle Tab Content -->
        <div v-show="activeTab === 'puzzle'" class="puzzle-tab-content">
          <div class="rating-block">
            <span class="rating-label">Rating</span>
            <div class="rating-row">
              <span class="rating-value">{{ displayRating }}</span>
              <Transition name="pop">
                <span
                  v-if="ratingDelta"
                  :key="ratingDelta.key"
                  class="rating-delta"
                  :class="ratingDelta.value >= 0 ? 'positive' : 'negative'"
                >
                  {{ ratingDelta.value >= 0 ? '+' : '' }}{{ ratingDelta.value }}
                </span>
              </Transition>
            </div>
            <div class="rating-meta">
              <span class="puzzles-remaining">{{ puzzleQueue.length }} left</span>
              <span class="streak-badge" v-if="streak > 1">🔥 {{ streak }}</span>
            </div>
          </div>

          <!-- Nice White/Black To Play Text -->
          <div class="turn-indicator">
            <span v-if="currentPuzzle?.turn === 'white'" class="turn-text white-turn">⚪ White to Play</span>
            <span v-else class="turn-text black-turn">⚫ Black to Play</span>
          </div>

          <!-- Move played in the actual game -->
          <div v-if="playedMoveSan" class="played-move-info">
            <span class="played-move-label">Your move in the game:</span>
            <div style="display: flex; align-items: center; gap: 0.35rem;">
              <img v-if="currentPuzzle?.playedMoveAccuracy" 
                   :src="accuracySymbol(currentPuzzle.playedMoveAccuracy)" 
                   style="width: 18px; height: 18px;" />
              <span class="played-move-san">{{ prettyMove(playedMoveSan) }}</span>
            </div>
          </div>

          <div class="action-buttons">
            <button v-if="status === 'idle' && !hintShown" class="tool-btn primary" @click="showHint">
              💡 Hint
            </button>
            <button v-if="status === 'idle' && hintShown" class="tool-btn outline" @click="showSolution">
              👁️ Show Solution
            </button>
            
            <button v-if="status === 'correct'" class="tool-btn primary" @click="loadRandomPuzzle">
              Next Puzzle →
            </button>
            
            <button v-if="status === 'wrong' && !solutionShown" class="tool-btn outline" @click="undoMoveAndResetStatus">
              ↩️ Try Again
            </button>
            <button v-if="status === 'wrong' && !solutionShown" class="tool-btn outline" @click="showSolution">
              Show Solution
            </button>
            <button v-if="status === 'wrong' && solutionShown" class="tool-btn primary" @click="loadRandomPuzzle">
              Next Puzzle →
            </button>
          </div>
          
          <div class="bottom-row">
            <p class="kbd-hint">Space: Next &nbsp;·&nbsp; H: Hint &nbsp;·&nbsp; S: Solution</p>
            <button class="icon-btn-sound" @click="soundOn = !soundOn">
              {{ soundOn ? '🔊' : '🔇' }}
            </button>
          </div>
        </div>

        <!-- Analysis Tab Content -->
        <div v-show="activeTab === 'analysis'" class="analysis-tab-content">
          <div class="analysis-panel">
            <div class="analyzis-header">
              <h3 class="analyzis-title">
                Engine Analysis
                <span v-if="isAnalyzing" class="thinking-dot" title="Engine is thinking"></span>
              </h3>
            </div>

            <div v-if="moveData" class="move-data">
              <p class="depthnum">Depth {{ currentDepth }}</p>
              
              <div class="line">
                <span class="evalnum2">{{ formatEval(moveData?.eval) }}</span>
                <span v-for="(move, idx) in sanLine" :key="'best-' + idx" class="line-move" @click="playLineMoves(moveData.best_line, idx + 1)">
                  {{ prettyMove(move) }}&nbsp;
                </span>
              </div>

              <div class="secondline" v-if="excellentSanLine.length">
                <span class="evalnum3">{{ moveData?.excellent_eval != null ? (moveData.excellent_eval / 100).toFixed(2) : "" }}</span>
                <span v-for="(move, idx) in excellentSanLine" :key="'exc-' + idx" class="line-move" @click="playLineMoves(moveData.excellent_line, idx + 1)">
                  {{ prettyMove(move) }}&nbsp;
                </span>
              </div>

              <div class="secondline" v-if="thirdSanLine.length">
                <span class="evalnum3">{{ moveData?.third_eval != null ? (moveData.third_eval / 100).toFixed(2) : "" }}</span>
                <span v-for="(move, idx) in thirdSanLine" :key="'third-' + idx" class="line-move" @click="playLineMoves(moveData.third_line, idx + 1)">
                  {{ prettyMove(move) }}&nbsp;
                </span>
              </div>

              <p :style="{color: color}" class="accuracydescribtion">{{ isAccuracy }}</p>
              <p class="bestmove" v-if="movesListUCI.length > 0">{{ displayBest() }}</p>
            </div>
            <div v-else class="move-data">
              <p class="depthnum">Waiting for engine...</p>
            </div>

            <!-- Moves List (Tree) -->
            <div class="moveslist-wrapper">
              <div class="moveslist">
                <template v-for="row in renderedMoves" :key="row.key">
                  <div class="move-row" :class="{ variant: row.depth > 0 }" :style="{ '--indent': `${row.depth * 1.05}rem` }">
                    <div
                      v-for="(cell, index) in row.cells"
                      :key="cell ? cell.key : `${row.key}-empty-${index}`"
                      class="move-cell"
                      :class="[{ active: cell && cell.node === currentNode, variant: cell && cell.variant }, { empty: !cell }]"
                      @click="cell && jumpToNode(cell.node.id)"
                    >
                      <template v-if="cell">
                        <span v-if="cell.showNum" class="move-num">{{ cell.displayNum }}{{ cell.isWhite ? '.' : '...' }}</span>
                        <span class="move-san-text">{{ cell.node.san }}</span>
                        <img v-if="cell.node.accuracy" :src="accuracySymbol(cell.node.accuracy)" class="acc-badge" :class="cell.node.accuracy"/>
                      </template>
                    </div>
                  </div>
                </template>
              </div>
            </div>

          </div>
        </div>

      </div>
    </template>
  </div>
</template>

<style scoped>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');

  .grid-layout {
    box-sizing: border-box;
    max-width: 1400px;
    margin: 0 auto;
    padding: clamp(0.5rem, 3vw, 1rem);
    display: grid;
    grid-template-columns: 1fr;
    grid-template-areas: "title" "board" "sidebar";
    gap: 1.5rem;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  }

  @media (min-width: 768px) {
    .grid-layout {
      grid-template-columns: auto 1fr;
      grid-template-areas: "title board" "title sidebar";
      gap: 1.5rem 2rem;
    }
  }

  @media (min-width: 1200px) {
    .grid-layout {
      grid-template-columns: auto 2fr 1.2fr;
      grid-template-areas: "title board sidebar";
      gap: 2rem;
    }
  }

  .title-slot { grid-area: title; min-width: 0; }
  .board-area { grid-area: board; display: flex; justify-content: center; width: 100%; min-width: 0; }
  .puzzle-sidebar { grid-area: sidebar; max-width: 380px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; }
  .empty-state { grid-column: 1; grid-row: 2 / 4; }
  @media (min-width: 768px) { .empty-state { grid-column: 2; grid-row: 1 / 3; } }
  @media (min-width: 1200px) { .empty-state { grid-column: 2 / 4; grid-row: 1; } }

  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 1rem; min-height: 50vh; padding: 3rem 1rem; text-align: center;
    color: rgba(244, 240, 227, 0.7); font-size: 1rem;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px;
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45);
  }
  .exhausted-state h2 { margin: 0; font-family: serif; font-size: 2rem; color: #f5f5dc; }
  .trophy-icon { font-size: 4rem; text-shadow: 0 4px 15px rgba(255, 215, 0, 0.3); }
  .exhausted-actions { margin-top: 1rem; }
  .empty-state .muted { max-width: 400px; margin-top: 1.5rem; font-size: 0.85rem; color: rgba(244, 240, 227, 0.4); }

  .loading-spinner { position: relative; width: 56px; height: 56px; margin-bottom: 1rem; }
  .spinner-ring {
    position: absolute; inset: 0; border: 3px solid transparent; border-radius: 50%;
    border-top-color: var(--text-highlight); animation: spinRing 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }
  .spinner-ring:nth-child(2) { inset: 7px; border-top-color: #a8d97a; animation-duration: 1.6s; animation-direction: reverse; }
  .spinner-ring:nth-child(3) { inset: 14px; border-top-color: #f4f0e3; animation-duration: 2s; }
  @keyframes spinRing { to { transform: rotate(360deg); } }

  .board-wrapper {
    position: relative; width: 100%; max-width: min(95vw, 40rem); min-width: 0; margin: 0 auto;
    display: flex; flex-direction: column;
  }
  .board-col { flex: 1 1 auto; min-width: 0; position: relative; display: flex; flex-direction: column; }
  .game-board { width: 100% !important; height: auto !important; aspect-ratio: 1 / 1 !important; display: block; }

  :deep(.cg-wrap) {
    width: 100% !important; height: 100% !important; overflow: hidden;
    border-radius: 8px; box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4);
  }
  :deep(cg-board) {
    background: conic-gradient(
      var(--board-dark) 90deg, var(--board-light) 90deg 180deg,
      var(--board-dark) 180deg 270deg, var(--board-light) 270deg
    ) !important;
    background-size: 25% 25% !important;
  }
  .board-row { display: flex; justify-content: center; gap: 0.75rem; width: 100%; }

  .player-bar {
    box-sizing: border-box; display: flex; align-items: center; gap: 0.5rem;
    width: 100%; padding: 0.35rem 0.7rem; margin-bottom: 0.2rem; border-radius: 8px;
    background: rgba(0, 0, 0, 0.22); color: #f4f0e3; font-size: clamp(0.82rem, 1.8vw, 0.95rem);
  }
  .player-bar.bottom { margin-top: 0.2rem; margin-bottom: 0; }
  .player-color-dot { width: 0.6rem; height: 0.6rem; flex-shrink: 0; border-radius: 50%; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3); }
  .player-color-dot.white { background: #f4f0e3; }
  .player-color-dot.black { background: #1a1a1a; }
  .player-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }

  .evalbar {
    position: relative; width: clamp(24px, 4vw, 40px); flex-shrink: 0; display: flex;
    flex-direction: column; opacity: 0; pointer-events: none; transition: opacity 0.3s ease;
  }
  .evalbar.is-visible { opacity: 1; }
  .evalbar-inner {
    position: relative; width: 100%; height: 100%; display: flex; flex-direction: column;
    overflow: hidden; border-radius: 10px; box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.5);
  }
  .blackeval, .whiteeval { width: 100%; transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1); }
  .blackeval { background-color: #38412e; }
  .whiteeval { background-color: #626949; }
  .evalnum {
    position: absolute; top: 50%; left: 50%; z-index: 10; width: max-content; padding: 0.25rem 0.4rem;
    transform: translate(-50%, -50%); white-space: nowrap; font-family: "JetBrains Mono", monospace;
    font-size: clamp(0.62rem, 1vw, 0.85rem); font-weight: 600; color: #fff8ef;
    text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.6); background: rgba(0, 0, 0, 0.3);
    border-radius: 6px; backdrop-filter: blur(4px);
  }

  /* --- Sidebar Layout --- */
  .puzzle-sidebar {
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px;
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }

  .tabs-container {
    display: flex; width: 100%; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .tab-btn {
    flex: 1; padding: 1rem 0.5rem; background: transparent; border: none; cursor: pointer;
    color: rgba(244, 240, 227, 0.5); font-size: 0.9rem; font-weight: 600; letter-spacing: 0.5px;
    text-transform: uppercase; transition: all 0.2s ease; position: relative;
  }
  .tab-btn.active {
    color: #f5f5dc; background: rgba(255, 255, 255, 0.03);
  }
  .tab-btn.active::after {
    content: ''; position: absolute; bottom: 0; left: 20%; right: 20%; height: 3px;
    background: var(--text-highlight); border-radius: 3px 3px 0 0;
  }
  .tab-btn:disabled {
    cursor: not-allowed; opacity: 0.3;
  }

  .puzzle-tab-content {
    display: flex; flex-direction: column; padding: 1.25rem 1.5rem; gap: 1.1rem; flex: 1;
  }
  .analysis-tab-content {
    display: flex; flex-direction: column; padding: 1.5rem; gap: 1.5rem; flex: 1;
  }

  .rating-block {
    display: flex; flex-direction: column; align-items: center; gap: 0.25rem; padding: 0.5rem 0;
  }
  .rating-label {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(244, 240, 227, 0.5);
  }
  .rating-row {
    position: relative; display: flex; align-items: baseline; justify-content: center;
  }
  .rating-value {
    font-family: "JetBrains Mono", monospace; font-size: 3rem; font-weight: 700; line-height: 1; color: var(--text-highlight);
  }
  .rating-delta {
    position: absolute; left: 100%; bottom: 10%; white-space: nowrap; margin-left: 0.75rem;
    font-family: "JetBrains Mono", monospace; font-size: 1.2rem; font-weight: 700;
  }
  .rating-delta.positive { color: #a8d97a; }
  .rating-delta.negative { color: #ff8a80; }
  .pop-enter-active { animation: popUp 1.2s ease forwards; }
  @keyframes popUp {
    0%   { opacity: 0; transform: translateY(4px); }
    15%  { opacity: 1; transform: translateY(-2px); }
    75%  { opacity: 1; transform: translateY(-10px); }
    100% { opacity: 0; transform: translateY(-16px); }
  }
  .rating-meta {
    display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  }
  .puzzles-remaining {
    font-size: 0.75rem; color: rgba(244, 240, 227, 0.4); font-weight: 500;
  }
  .streak-badge {
    padding: 0.2rem 0.55rem; font-size: 0.72rem; font-weight: 700; color: #ffb74d;
    background: rgba(255, 165, 0, 0.15); border: 1px solid rgba(255, 165, 0, 0.3); border-radius: 6px;
  }

  .turn-indicator {
    text-align: center;
    padding: 0.75rem 1rem;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.05);
    margin-top: 0.5rem;
    font-weight: 700;
    font-size: 1.1rem;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .white-turn { color: #f4f0e3; }
  .black-turn { color: #1a1a1a; text-shadow: 0 0 2px rgba(255,255,255,0.5); }

  .played-move-info {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.6rem;
    padding: 0.7rem 1rem;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 0.95rem;
  }
  .played-move-label {
    color: rgba(244, 240, 227, 0.6);
    font-weight: 500;
  }
  .played-move-san {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    color: var(--text-highlight);
    font-size: 1.15rem;
    letter-spacing: 0.5px;
  }

  .action-buttons {
    margin-top: auto; display: flex; flex-direction: column; gap: 0.75rem;
  }
  .tool-btn {
    display: block; padding: 0.85rem 1.5rem; text-align: center; text-decoration: none;
    font-size: 1rem; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; transition: all 0.2s ease;
  }
  .tool-btn.outline { color: #e8e8d0; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.1); }
  .tool-btn.outline:hover { background: rgba(255, 255, 255, 0.1); }
  .tool-btn.primary { color: #15130d; background: var(--text-highlight); box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3); }
  .tool-btn.primary:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); filter: brightness(1.1); }

  .bottom-row {
    display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem;
  }
  .kbd-hint { margin: 0; font-size: 0.65rem; text-align: center; color: rgba(244, 240, 227, 0.3); }
  .icon-btn-sound {
    width: 2rem; height: 2rem; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    font-size: 0.9rem; color: #e8e8d0; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 6px; cursor: pointer; transition: background 0.2s ease;
  }
  .icon-btn-sound:hover { background: rgba(255, 255, 255, 0.1); }

  /* --- Board Tools (Navigation) --- */
  .boardtools {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    align-items: center;
    min-height: 3.2rem;
    width: 100%;
    box-sizing: border-box;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border: 2px solid rgba(182, 173, 144, 0.4);
    padding: 0.5rem 1rem;
    border-radius: 10px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    margin: 0.4rem 0 0 0;
    flex-wrap: wrap;
  }
  .jumpstart, .undo, .redo, .reverse, .jumpend {
    background-color: var(--btn-idle);
    width: clamp(35px, 8vw, 40px);
    height: clamp(35px, 8vw, 40px);
    border: none;
    border-radius: 15px;
    font-size: clamp(16px, 4vw, 20px);
    color: #e8e8d0;
    cursor: pointer;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }
  .jumpstart:disabled, .undo:disabled, .redo:disabled, .jumpend:disabled {
    opacity: 0.4; cursor: not-allowed;
  }
  .jumpstart:hover:not(:disabled), .undo:hover:not(:disabled), .redo:hover:not(:disabled), 
  .reverse:hover, .jumpend:hover:not(:disabled) {
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border-color: rgba(232, 232, 208, 0.6);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  /* --- Moves List (Tree) --- */
  .moveslist-wrapper {
    margin-top: 1rem; 
    overflow-y: auto; 
    max-height: 250px;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.2) rgba(0, 0, 0, 0.2);
    border-radius: 12px;
    background: linear-gradient(135deg, var(--list-1), var(--list-2));
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
    padding: 0.5rem;
  }
  .moveslist {
    display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.9rem;
  }
  .move-row {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.4rem; align-items: start;
    margin-left: var(--indent, 0rem); padding-left: 0.35rem; position: relative;
  }
  .move-row.variant { border-left: 2px solid rgba(232, 232, 208, 0.16); }
  .move-cell {
    min-height: 2.2rem; padding: 0.4rem 0.6rem; border-radius: 8px; cursor: pointer;
    color: #f4f0e3; font-weight: 500; transition: all 0.15s ease; display: flex;
    align-items: center; flex-wrap: wrap; gap: 0.3rem; background: rgba(0, 0, 0, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.06); box-sizing: border-box; overflow: hidden; user-select: none;
  }
  .move-cell:hover { background: rgba(103, 122, 228, 0.18); }
  .move-cell.active {
    background: linear-gradient(135deg, rgba(103, 122, 228, 0.42), rgba(103, 122, 228, 0.22));
    border-color: rgba(220, 228, 255, 0.7); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 18px rgba(103, 122, 228, 0.25);
  }
  .move-cell.variant { color: #dbe4ff; background: rgba(255, 255, 255, 0.06); }
  .move-cell.empty { pointer-events: none; background: transparent; border-color: transparent; box-shadow: none; }
  .move-num {
    color: rgba(232, 232, 208, 0.72); font-size: 0.78em; font-weight: 700; padding: 0.15rem 0.45rem;
    border-radius: 999px; background: rgba(0, 0, 0, 0.16);
  }
  .move-san-text { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acc-badge { width: 16px; height: 16px; border-radius: 50%; margin-left: 2px; }

  /* --- Analysis Panel Styles --- */
  .analysis-panel {
    display: flex; flex-direction: column; height: 100%; gap: 0.5rem;
  }
  .analyzis-header { margin-bottom: 0.5rem; }
  .analyzis-title {
    display: flex; align-items: center; gap: 0.5rem; margin: 0; font-family: serif;
    font-size: 1rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #f5f5dc;
  }
  .thinking-dot {
    width: 0.4rem; height: 0.4rem; border-radius: 50%; background: #6ad13f;
    box-shadow: 0 0 8px rgba(106, 209, 63, 0.9); animation: thinkingPulse 1s ease-in-out infinite;
  }
  @keyframes thinkingPulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.15); } }

  .depthnum {
    margin: 0 0 0.5rem; font-family: 'Inter', sans-serif; font-size: 0.75rem; font-weight: 600;
    text-transform: uppercase; color: rgba(245, 245, 220, 0.6);
  }
  .line, .secondline {
    font-family: "JetBrains Mono", monospace; display: flex; white-space: nowrap; align-items: center;
    gap: 0.5rem; font-size: clamp(0.85rem, 2vw, 1rem); padding: 0.5rem; margin: 8px 0;
    background: rgba(0, 0, 0, 0.25); border-radius: 10px; color: #eae4d8;
    box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.4); overflow-x: auto; scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.2) rgba(0, 0, 0, 0.2);
  }
  .evalnum2, .evalnum3 {
    font-size: clamp(1rem, 2vw, 1.3rem); color: #171717; background-color: #606847; border-radius: 10px;
    flex-shrink: 0; min-width: 4.4rem; width: auto; padding: 0 0.5rem; text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .line-move { padding: 0 2px; cursor: pointer; }
  .line-move:hover { background: rgba(103, 122, 228, 0.3); border-radius: 4px; }

  .accuracydescribtion {
    font-weight: 500; text-align: center; font-size: clamp(1rem, 2.1vw, 1.2rem);
    margin-top: 1rem; padding: 0 1rem; word-wrap: break-word;
  }
  .bestmove {
    color: #41a24e; text-align: center; font-weight: 600; margin-top: 0.1rem;
    font-size: clamp(0.9rem, 1rem, 1.1rem); padding: 0 1rem;
  }

  /* --- Board Overlays --- */
  .board-acc-icon {
    position: absolute;
    width: 4.5%;
    height: 4.5%;
    border-radius: 50%;
    pointer-events: none;
    z-index: 20;
  }
  
  .status-icon {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    z-index: 21;
  }

  .hint-overlay {
    z-index: 10; 
    display: flex; 
    align-items: center; 
    justify-content: center; 
    pointer-events: none;
  }
  .hint-circle {
    width: 70%; 
    height: 70%; 
    border-radius: 50%; 
    background: radial-gradient(circle, rgba(255, 215, 0, 0.4) 0%, rgba(255, 215, 0, 0) 70%);
    box-shadow: 0 0 15px 5px rgba(255, 215, 0, 0.3);
    animation: hintPulse 1.5s infinite;
  }
  @keyframes hintPulse {
    0% { transform: scale(0.7); opacity: 0.5; }
    50% { transform: scale(1.1); opacity: 1; }
    100% { transform: scale(0.7); opacity: 0.5; }
  }

  /* --- Pretty Scrollbars --- */
  .line::-webkit-scrollbar,
  .secondline::-webkit-scrollbar,
  .moveslist-wrapper::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .line::-webkit-scrollbar-track,
  .secondline::-webkit-scrollbar-track,
  .moveslist-wrapper::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
  }
  .line::-webkit-scrollbar-thumb,
  .secondline::-webkit-scrollbar-thumb,
  .moveslist-wrapper::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
  }
  .line::-webkit-scrollbar-thumb:hover,
  .secondline::-webkit-scrollbar-thumb:hover,
  .moveslist-wrapper::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.3);
  }
</style>