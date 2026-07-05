<script setup>
  import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
  import { Chess } from 'chess.js'
  import { TheChessboard } from 'vue3-chessboard'
  import 'vue3-chessboard/style.css'
  import Title from "../assets/Title.vue"
  import SettingsPanel from "../assets/SettingsPanel.vue" // <-- Import new component
  import { startEngine, getEvaluation, cancelAnalysis } from "../engine/engine.js"

  onMounted(async () => {
    window.addEventListener('keydown', handleKeyDown)
      await startEngine();
      await getAccuracy();
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeyDown)
    clearTimeout(toastTimeout)
  })

  // State
  const isSettingsOpen = ref(false)
  const boardTheme = ref('brown') // Connect this to your board config later if supported
  const isFlipped = computed(() => (rotate.value / 180) % 2 === 1)

  const chess = new Chess()
  const greedyChess = new Chess()
  const excellentChess = new Chess()
  const bestChess = new Chess()
  const thirdChess = new Chess()

  const moveData = shallowRef(null)
  const boardAPI = shallowRef(null)
  const isAnalyzing = ref(false)
  const currentDepth = ref(10)
  const targetDepth = ref(10)
  const height = ref(47.75)
  const cp = ref(0)
  const rotate = ref(0)
  const isAccuracy = ref("")
  const color = ref("")
  const sanLine = ref([])
  const bestMoveSan = ref('')
  const excellentSanLine = ref([])
  const treeVersion = ref(0)
  const movesListUCI = ref([])
  const lastMoveSquare = ref(null)
  const lastMoveAccuracy = ref(null)
  const boardRef = ref(null)
  const movesListRef = ref(null)
  const thirdSanLine = ref([])
  const soundOn = ref(true)
  const showBestArrow = ref(true)
  const bestArrowSquares = ref(null) 
  const toastMessage = ref('')
  let toastTimeout = null
  let audioCtx = null

  let accuracyDebounceTimer = null
  let lastPress = 0

  const moveTree = {
    id: 0,
    san: null,
    uci: null,
    fen: chess.fen(),
    accuracy: null,
    parent: null,
    children: []
  }

  let nodeIdCounter = 1

  const nodeMap = { 0: moveTree }
  const currentNode = shallowRef(moveTree)

  const renderedMoves = computed(() => {
    treeVersion.value
    const rows = []

    function makeCell(node, moveNum, showAsStart, depth) {
      const isWhite = moveNum % 2 === 1
      return {
        key: `cell-${node.id}-${moveNum}-${depth}`,
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
          key: `row-${current.id}-${ply}-${depth}-${rows.length}`,
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

  const materialInfo = computed(() => {
    treeVersion.value
    const startCounts = { p: 8, n: 2, b: 2, r: 2, q: 1 }
    const remaining = { w: { ...startCounts }, b: { ...startCounts } }

    for (const row of chess.board()) {
      for (const square of row) {
        if (!square || square.type === 'k') continue
        remaining[square.color][square.type]--
      }
    }

    const values = { p: 1, n: 3, b: 3, r: 5, q: 9 }
    let diff = 0
    const capturedByWhite = []
    const capturedByBlack = []

    for (const type of ['q', 'r', 'b', 'n', 'p']) {
      const blackLost = remaining.b[type]
      const whiteLost = remaining.w[type]
      diff += values[type] * (blackLost - whiteLost)
      for (let i = 0; i < blackLost; i++) capturedByWhite.push(type)
      for (let i = 0; i < whiteLost; i++) capturedByBlack.push(type)
    }

    return { diff, capturedByWhite, capturedByBlack }
  })

  function pieceSymbol(type, pieceColor) {
    const whiteMap = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }
    const blackMap = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }
    return (pieceColor === 'w' ? whiteMap : blackMap)[type] || ''
  }

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
        move:    { freq: 520, gain: 0.06, dur: 0.09 },
        capture: { freq: 260, gain: 0.10, dur: 0.14 },
        check:   { freq: 880, gain: 0.10, dur: 0.20 },
      }
      const p = presets[type] ?? presets.move

      osc.type = type === 'capture' ? 'square' : 'sine'
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

  // Watchers to trigger drawing immediately if toggled from modal
  watch(showBestArrow, (val) => {
    if (!val && boardAPI.value) boardAPI.value.hideMoves()
    else drawBestArrow()
  })

  function showToast(message) {
    toastMessage.value = message
    clearTimeout(toastTimeout)
    toastTimeout = setTimeout(() => { toastMessage.value = '' }, 1800)
  }

  async function copyToClipboard(text, label) {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`${label} copied to clipboard`)
    } catch (e) {
      showToast(`Couldn't copy ${label.toLowerCase()}`)
    }
  }

  function copyPGN() { copyToClipboard(chess.pgn() || '(no moves yet)', 'PGN') }
  function copyFEN() { copyToClipboard(chess.fen(), 'FEN') }

  function drawBestArrow() {
    if (!showBestArrow.value || !boardAPI.value || !bestArrowSquares.value) return
    const { from, to } = bestArrowSquares.value
    boardAPI.value.drawMove(from, to, 'blue')
  }

  async function onBoardCreated(api) {
    boardAPI.value = api
    chess.reset()
    boardAPI.value.setPosition(chess.fen())
  }

  async function handleBothMoves(move) {
    const uci = move.promotion ? `${move.from}${move.to}${move.promotion}` : `${move.from}${move.to}`
    const sanMove = chess.move({ from: move.from, to: move.to, promotion: move.promotion ?? undefined })
    
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
        id: nodeIdCounter++, san: sanMove.san, uci, fen: chess.fen(), accuracy: null, parent: currentNode.value, children: []
      }
      nodeMap[newNode.id] = newNode
      currentNode.value.children.push(newNode)
      currentNode.value = newNode
    }

    movesListUCI.value.push(uci)
    treeVersion.value++
    await getAccuracy()
  }

  function undoMove() {
    lastMoveSquare.value = null
    lastMoveAccuracy.value = null
    if (currentNode.value.parent === null) return
    chess.undo()
    currentNode.value = currentNode.value.parent
    movesListUCI.value.pop()
    boardAPI.value.setPosition(chess.fen())
    treeVersion.value++
  }

  function redoMove() {
    lastMoveSquare.value = null
    lastMoveAccuracy.value = null
    if (currentNode.value.children.length === 0) return
    const nextNode = currentNode.value.children[0]
    const sanMove = chess.move(nextNode.uci)
    if (sanMove) soundForLastMove(sanMove)
    movesListUCI.value.push(nextNode.uci)
    currentNode.value = nextNode
    boardAPI.value.setPosition(nextNode.fen)
    treeVersion.value++
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

    chess.reset()
    for (const uci of uciMoves) chess.move(uci)

    movesListUCI.value = uciMoves
    currentNode.value = node
    boardAPI.value.setPosition(node.fen)
    moveData.value = null
    isAccuracy.value = ""
    color.value = ""
    treeVersion.value++
    getAccuracy()
  }

  function goToStart() { jumpToNode(0) }
  function goToEnd() {
    let node = currentNode.value
    while (node.children.length > 0) node = node.children[0]
    jumpToNode(node.id)
  }

  function resetBoard() {
    chess.reset()
    boardAPI.value.setPosition(chess.fen())
    movesListUCI.value = []
    currentNode.value = moveTree
    moveTree.children = []
    moveTree.fen = chess.fen()
    nodeIdCounter = 1
    for (const key in nodeMap) {
      if (parseInt(key) !== 0) delete nodeMap[key]
    }
    treeVersion.value++
    getAccuracy()
  }

  function resetAccuracy() {
    resetBoard()
    isAccuracy.value = ""
    color.value = ""
    moveData.value = null
  }

  async function getAccuracy() {
    await cancelAnalysis()
    isAnalyzing.value = true
    bestArrowSquares.value = null
    if (showBestArrow.value && boardAPI.value) boardAPI.value.hideMoves()

    await getEvaluation(
      movesListUCI.value.length === 0 ? '' : movesListUCI.value.at(-1),
      movesListUCI.value.slice(0, -1),
      targetDepth.value,
      (result) => {
        moveData.value = result
        lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
        lastMoveAccuracy.value = result.move_accuracy
        currentNode.value.accuracy = result.move_accuracy
        currentDepth.value = result.depth
        isAnalyzing.value = false
        
        if (typeof evalSize === "function") evalSize()
        if (typeof moveDescription === "function") moveDescription()
        if (typeof sanBest === "function") sanBest()
        if (typeof uciSecondLine === "function") uciSecondLine()
        if (typeof uciThirdLine === "function") uciThirdLine()
        if (typeof uciLine === "function") uciLine()
        drawBestArrow()
        
        treeVersion.value++
      }
    )
  }

  function onDepthChange() { getAccuracy() }

  function formatEval(evalObj) {
    if (!evalObj) return ""
    if (evalObj.type === "cp") return (evalObj.value / 100).toFixed(2)
    if (evalObj.type === "mate") return `#${evalObj.value}`
  }

  function evalSize() {
      if (!moveData.value || !moveData.value.eval) return
      const evalValue = moveData.value.eval.value
      const evalType = moveData.value.eval.type
      if (evalType === "mate") {
          if (evalValue >= 0) { cp.value = 800; height.value = 0 }
          else { cp.value = -800; height.value = 95.5 }
          return
      }
      cp.value = Math.max(-800, Math.min(800, evalValue))
      height.value = 47.75 - (cp.value / 800) * 47.75
  }

  function flipBoard() {
    boardAPI.value.toggleOrientation()
    rotate.value += 180
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
  }

  function moveDescription() {
    isAccuracy.value = ''
    if (!currentNode.value.san) return
    const descriptions = {
      great:      { color: '#4c8cb5',  text: ' is a great move!'},
      brilliant:  { color: '#03aea7', text: ' is a brilliant move!!' },
      book:       { color: '#ad8760',   text: ' is a book move' },
      best:       { color: '#6ad13f',   text: ' is the best move' },
      excellent:  { color: '#90bc36',   text: ' is an excellent move' },
      good:       { color: '#8eae83', text: ' is a good move' },
      inaccuracy: { color: '#f2bc43',   text: ' is an inaccuracy' },
      mistake:    { color: '#f38800',   text: ' is a mistake' },
      blunder:    { color: '#FF0000',   text: ' is a blunder' },
    }
    const config = descriptions[moveData.value.move_accuracy]
    if (!config) return
    color.value = config.color
    isAccuracy.value = prettyMove(currentNode.value.san)  + config.text
  }

  function displayBest() {
    if (['brilliant', 'best', 'great', 'book'].includes(moveData.value.move_accuracy)) return ""
    if (moveData.value.best_move === "") return ""
    return prettyMove(bestMoveSan.value) + " was the best"
  }

  function uciLine() {
    sanLine.value = []
    bestArrowSquares.value = null
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

  function sanBest() {
    if (!moveData.value?.best_move) return 
    bestChess.reset()
    for (const move of moveData.value.moves_list.slice(0, -1)) bestChess.move(move)
    const bestMoveBefore = moveData.value.best_move
    const bestMove = bestChess.move(bestMoveBefore, { sloppy: true })
    if (!bestMove) return
    bestMoveSan.value = bestMove.san
  }

  function uciSecondLine() {
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

  function prettyMove(move) {
    const pieces = { 'K': '♚', 'Q': '♛', 'R': '♜', 'B': '♝', 'N': '♞' }
    return move.replace(/[KQRBN]/g, p => pieces[p])
  }

  function squareStyle(square) {
      if (!square || !boardRef.value) return {}
      const boardEl = boardRef.value.querySelector('.cg-wrap')
      if (!boardEl) return {}
      
      const boardRect = boardEl.getBoundingClientRect()
      const wrapperRect = boardRef.value.getBoundingClientRect()
      const squareSize = boardRect.width / 8

      const file = square.charCodeAt(0) - 97
      const rank = parseInt(square[1]) - 1
      const isFlipped = (rotate.value / 180) % 2 === 1
      const col = isFlipped ? 7 - file : file
      const row = isFlipped ? rank : 7 - rank

      const offsetX = boardRect.left - wrapperRect.left
      const offsetY = boardRect.top - wrapperRect.top

      return {
          position: 'absolute',
          left: `${offsetX + (col + 1) * squareSize}px`,
          top: `${offsetY + row * squareSize}px`,  
          transform: 'translate(-70%, -35%)',
      }
  }

  async function playMove() {
      if (!moveData.value?.best_move) return
      const uci = moveData.value.best_move
      const from = uci.slice(0, 2)
      const to = uci.slice(2, 4)
      const promotion = uci.length > 4 ? uci[4] : undefined

      undoMove()

      const sanMove = chess.move({ from, to, promotion: promotion ?? undefined })
      if (!sanMove) return

      soundForLastMove(sanMove)

      const existing = currentNode.value.children.find(c => c.uci === uci)
      if (existing) {
          currentNode.value = existing
      } else {
          const newNode = {
              id: nodeIdCounter++, san: sanMove.san, uci, fen: chess.fen(), accuracy: null, parent: currentNode.value, children: []
          }
          nodeMap[newNode.id] = newNode
          currentNode.value.children.push(newNode)
          currentNode.value = newNode
      }

      movesListUCI.value.push(uci)
      boardAPI.value.setPosition(chess.fen())  
      treeVersion.value++
      getAccuracy()  
  }

  const handleKeyDown = (event) => {
      const delay = 200 
      const currentTime = Date.now()

      if (event.repeat) return

      switch (event.key) {
          case 'ArrowLeft':
              if (currentTime - lastPress < delay) return
              lastPress = currentTime
              undoAccuracy()
              break
          case 'ArrowRight':
              if (currentTime - lastPress < delay) return
              lastPress = currentTime
              redoAccuracy()
              break
          case 'Home':
              event.preventDefault()
              goToStart()
              break
          case 'End':
              event.preventDefault()
              goToEnd()
              break
      }
  }

  function applyUciMove(uci) {
      const from = uci.slice(0, 2)
      const to = uci.slice(2, 4)
      const promotion = uci.length > 4 ? uci[4] : undefined

      const sanMove = chess.move({ from, to, promotion: promotion ?? undefined })
      if (!sanMove) return false

      const existing = currentNode.value.children.find(c => c.uci === uci)
      if (existing) {
        currentNode.value = existing
      } else {
        const newNode = {
              id: nodeIdCounter++, san: sanMove.san, uci, fen: chess.fen(), accuracy: null, parent: currentNode.value, children: []
          }
          nodeMap[newNode.id] = newNode
          currentNode.value.children.push(newNode)
          currentNode.value = newNode
        }

        movesListUCI.value.push(uci)
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
</script>

<template>
  <SettingsPanel 
    v-model:isOpen="isSettingsOpen"
    v-model:targetDepth="targetDepth"
    v-model:soundOn="soundOn"
    v-model:showBestArrow="showBestArrow"
    v-model:boardTheme="boardTheme"
    @depthChanged="onDepthChange"
  />

  <div class="grid-layout">
    <Title class="app-title" /> 
    
    <div class="board-area">
      <div class="board-layout">
        
        <div class="board-and-eval">
          <div class="evalbar">
            <div class="evalbar-inner">
              <template v-if="!isFlipped">
                <div class="blackeval" :style="{ height: height + '%', borderRadius: '10px 10px 0 0'}"></div>
                <div class="whiteeval" :style="{ height: 95.5-height + '%', borderRadius: '0 0 10px 10px'}"></div>
              </template>
              <template v-else>
                <div class="whiteeval" :style="{ borderRadius: '10px 10px 0 0', height: 95.5-height + '%' }"></div>
                <div class="blackeval" :style="{ height: height + '%', borderRadius: '0 0 10px 10px' }"></div>
              </template>
            </div>
            <p class="evalnum">{{ formatEval(moveData?.eval) }}</p>
          </div>

          <div class="board-core" ref="boardRef">
            <TheChessboard 
              @move="handleBothMoves" 
              @board-created="onBoardCreated" 
              :board-config="{ coordinates: true }" 
            />
            <img
              v-if="lastMoveSquare && lastMoveAccuracy"
              :src="accuracySymbol(lastMoveAccuracy)"
              class="board-acc-icon"
              :style="squareStyle(lastMoveSquare)"
            />
          </div>
        </div>

        <div class="material-row" v-if="materialInfo.capturedByWhite.length || materialInfo.capturedByBlack.length">
          <div class="material-side">
            <span v-for="(p, i) in materialInfo.capturedByBlack" :key="'cb'+i" class="captured-piece white">{{ pieceSymbol(p, 'w') }}</span>
            <span v-if="materialInfo.diff < 0" class="material-diff">+{{ -materialInfo.diff }}</span>
          </div>
          <div class="material-side">
            <span v-for="(p, i) in materialInfo.capturedByWhite" :key="'cw'+i" class="captured-piece black">{{ pieceSymbol(p, 'b') }}</span>
            <span v-if="materialInfo.diff > 0" class="material-diff">+{{ materialInfo.diff }}</span>
          </div>
        </div>
        
        <div class="boardtools">
          <button class="jumpstart" @click="goToStart" :disabled="currentNode.parent === null" title="Jump to start">⏮</button>
          <button class="undo" @click="undoAccuracy" title="previous" :disabled="currentNode.parent === null">↶</button>
          <button class="reverse" @click="flipBoard" title="flip board">↳↰</button>
          <button class="redo" title="next" @click="redoAccuracy" :disabled="currentNode.children.length === 0">↷</button>
          <button class="jumpend" @click="goToEnd" :disabled="currentNode.children.length === 0" title="Jump to end">⏭</button>
          <button class="reset" @click="resetAccuracy" title="reset">🗘</button>
        </div>
      </div>
    </div>
    
    <div class="analysis-container">
      <div class="analyze">
        <div class="analyzis-header">
          <h2 class="analyzis">
            Analysis
            <span v-if="isAnalyzing" class="thinking-dot" title="Engine is thinking"></span>
          </h2>
          <button class="settings-btn" @click="isSettingsOpen = true" title="Settings">⚙️</button>
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
          <p class="bestmove" v-if="movesListUCI.length > 0" @click="playMove">{{ displayBest() }}</p>
          
          <div class="sharebar">
            <button class="sharebtn" @click="copyPGN">Copy PGN</button>
            <button class="sharebtn" @click="copyFEN">Copy FEN</button>
          </div>
        </div>
      </div>
      
      <div class="moves">
        <h2 class="movehistory">Move history</h2>
        <div class="moveslist" ref="movesListRef">
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
  <Transition name="toast-fade">
    <div v-if="toastMessage" class="toast">{{ toastMessage }}</div>
  </Transition>
</template>

<style scoped>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600;700&display=swap');

  /* --- Grid Layout Architecture --- */
  .grid-layout {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    padding: 1rem;
    display: grid;
    grid-template-columns: 1fr;
    grid-template-areas: 
      "title"
      "board"
      "analysis";
    gap: 1.5rem;
    max-width: 1600px;
    margin: 0 auto;
    align-items: start;
  }

  .app-title { grid-area: title; justify-self: center; width: 100%; }
  .board-area { grid-area: board; display: flex; justify-content: center; width: 100%; }
  .analysis-container { grid-area: analysis; display: flex; flex-direction: column; gap: 1rem; width: 100%; }

  /* Tablet Breakpoint */
  @media (min-width: 850px) {
    .grid-layout {
      grid-template-columns: minmax(400px, 1.5fr) 1fr;
      grid-template-areas:
        "title title"
        "board analysis";
    }
  }

  /* Desktop Breakpoint */
  @media (min-width: 1200px) {
    .grid-layout {
      grid-template-columns: auto minmax(450px, 2fr) minmax(320px, 1.2fr);
      grid-template-areas: "title board analysis";
    }
    .app-title { justify-self: start; }
  }

  /* --- Board & Eval Area --- */
  .board-layout {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    max-width: 650px; /* Limits maximum board size */
  }

  .board-and-eval {
    display: flex;
    flex-direction: row;
    gap: 0.6rem;
    align-items: stretch; /* Forces Eval bar to perfectly match board height */
  }

  .board-core {
    position: relative;
    flex-grow: 1;
    width: 100%;
  }

  :deep(.cg-wrap) {
    width: 100%;
    height: auto; 
    aspect-ratio: 1;
    box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4);
    border-radius: 8px;
    overflow: hidden;
  }

  .evalbar {
    width: clamp(15px, 3vw, 25px);
    flex-shrink: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .evalbar-inner {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    overflow: hidden;
  }

  .blackeval, .whiteeval {
    width: 100%;
    transition: all 0.5s ease;
    position: relative;
  }
  .blackeval { background-color: #38412e; }
  .whiteeval { background-color: #626949; }

  .evalnum {
    font-family: "JetBrains Mono", monospace;
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: clamp(0.75rem, 1.5vw, 1.1rem);
    font-weight: 700;
    color: #fff8ef;
    text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.6);
    background: rgba(0, 0, 0, 0.3);
    padding: 0.25rem 0.4rem;
    border-radius: 6px;
    backdrop-filter: blur(4px);
    z-index: 10;
  }

  .board-acc-icon {
    position: absolute;
    width: 4.5%;
    height: 4.5%;
    border-radius: 50%;
    pointer-events: none;
    z-index: 5;
  }

  /* --- Material Display --- */
  .material-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.15rem 0.6rem;
    min-height: 1.6rem;
    font-size: 1.2rem;
  }

  .material-side { display: flex; align-items: center; gap: 0.05rem; flex-wrap: wrap; }
  .captured-piece.white { color: white; text-shadow: 0 0 1px #1a1208, 0 1px 1px rgba(0, 0, 0, 0.6); }
  .captured-piece.black { color: #14100c; text-shadow: 0 1px 2px rgba(255, 255, 255, 0.45); }

  .material-diff {
    font-family: "JetBrains Mono", monospace;
    margin-left: 0.4rem;
    font-size: 0.8rem;
    font-weight: 700;
    color: #a8d97a;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 6px;
    padding: 0.05rem 0.4rem;
  }

  /* --- Board Tools --- */
  .boardtools {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    align-items: center;
    min-height: 3.2rem;
    width: 100%;
    background: linear-gradient(145deg, #8b5a32, #6d4524);
    border: 2px solid rgba(182, 173, 144, 0.4);
    padding: 0.5rem 1rem;
    border-radius: 10px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    flex-wrap: wrap;
    box-sizing: border-box;
  }

  .reverse, .undo, .redo, .reset, .jumpstart, .jumpend {
    background-color: #9d6639;
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

  .reverse:disabled, .undo:disabled, .redo:disabled, .jumpstart:disabled, .jumpend:disabled {
    opacity: 0.4; cursor: not-allowed;
  }

  .reverse:hover:not(:disabled), .undo:hover:not(:disabled), .redo:hover:not(:disabled), 
  .reset:hover, .jumpstart:hover:not(:disabled), .jumpend:hover:not(:disabled) {
    background: linear-gradient(145deg, #9d6640, #7d5530);
    border-color: rgba(232, 232, 208, 0.6);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  /* --- Analysis Panels --- */
  .analyze {
    border-radius: 15px;
    width: 100%;
    min-height: 200px;
    padding-bottom: 1rem;
    background: linear-gradient(145deg, #8b5a32, #6d4524);
    box-sizing: border-box;
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .analyzis-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem 0.5rem;
  }

  .analyzis {
    font-family: serif;
    color: #f5f5dc;
    font-weight: 700;
    text-transform: uppercase;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
    letter-spacing: 2px;
    font-size: clamp(1.1rem, 2.5vw, 1.4rem);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }

  .settings-btn {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255,255,255,0.1);
    color: #fff;
    border-radius: 8px;
    width: 36px; height: 36px;
    display: flex; justify-content: center; align-items: center;
    cursor: pointer; transition: all 0.2s ease;
  }

  .settings-btn:hover { background: rgba(0, 0, 0, 0.4); transform: scale(1.05); }

  .thinking-dot {
    width: 0.5rem; height: 0.5rem; border-radius: 50%;
    background: #6ad13f; box-shadow: 0 0 8px rgba(106, 209, 63, 0.9);
    animation: thinkingPulse 1s ease-in-out infinite;
  }

  @keyframes thinkingPulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.15); } }

  .move-data { padding: 0 1rem; }
  .depthnum { font-family: 'Inter', sans-serif; text-align: center; color: rgba(245, 245, 220, 0.7); font-size: 0.78rem; font-weight: 600; text-transform: uppercase; margin: 0.3rem 0 0.5rem; }

  .line, .secondline {
    font-family: "JetBrains Mono", monospace;
    display: flex; white-space: nowrap; align-items: center; gap: 0.5rem;
    font-size: clamp(0.85rem, 2vw, 1rem);
    padding: 0.5rem; margin: 8px 0;
    background: rgba(0, 0, 0, 0.25); border-radius: 10px; color: #eae4d8;
    box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.4);
    overflow-x: auto; scrollbar-width: thin; scrollbar-color: rgba(0, 0, 0, 0.3) rgba(0, 0, 0, 0.1); 
  }

  .evalnum2, .evalnum3 {
    font-size: clamp(1rem, 2vw, 1.3rem); color: #171717; background-color: #606847;
    border-radius: 10px; flex-shrink: 0; width: 4.4rem; text-align: center;
  }

  .line-move { cursor: pointer; padding: 0 2px; border-radius: 4px; }
  .line-move:hover { background: rgba(103, 122, 228, 0.3); }

  .accuracydescribtion { font-weight: 500; text-align: center; font-size: clamp(1rem, 2.1vw, 1.2rem); margin-top: 1rem; padding: 0 1rem; word-wrap: break-word; }
  .bestmove { color: #41a24e; text-align: center; font-weight: 600; margin-top: 0.1rem; font-size: clamp(0.9rem, 1rem, 1.1rem); padding: 0 1rem; cursor: pointer; text-decoration: underline; }

  /* --- Move History --- */
  .moves {
    background: linear-gradient(145deg, #8b5a32, #6d4524);
    border-radius: 16px;
    width: 100%;
    height: clamp(300px, 50vh, 500px);
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .movehistory {
    font-family: serif; text-align: center; color: #f5f5dc; font-weight: 700;
    text-transform: uppercase; margin: 12px 0; text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
    letter-spacing: 2.5px; font-size: clamp(1.3rem, 3vw, 1.6rem); flex-shrink: 0;
  }

  .moveslist {
    margin: 0 12px 12px; padding: 12px;
    box-sizing: border-box; background: linear-gradient(135deg, #a57548, #7d5530);
    border-radius: 14px; font-size: clamp(0.9rem, 2vw, 1rem);
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
    display: flex; flex-direction: column; gap: 0.55rem;
    overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(194, 197, 170, 0.4) rgba(0, 0, 0, 0.2);
    flex-grow: 1;
  }

  .move-row {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem;
    align-items: start; margin-left: var(--indent, 0rem); padding-left: 0.35rem; position: relative;
  }
  .move-row.variant { border-left: 2px solid rgba(232, 232, 208, 0.16); }

  .move-cell {
    min-height: 2.45rem; padding: 0.55rem 0.7rem; border-radius: 12px; cursor: pointer; color: #f4f0e3;
    font-weight: 500; transition: all 0.15s ease; display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem;
    background: rgba(0, 0, 0, 0.12); border: 1px solid rgba(255, 255, 255, 0.06); box-sizing: border-box; overflow: hidden;
  }
  .move-cell:hover { background: rgba(103, 122, 228, 0.18); transform: translateY(-1px); }
  .move-cell.active {
    background: linear-gradient(135deg, rgba(103, 122, 228, 0.42), rgba(103, 122, 228, 0.22));
    border-color: rgba(220, 228, 255, 0.7); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 18px rgba(103, 122, 228, 0.25);
  }
  .move-cell.variant { color: #dbe4ff; background: rgba(255, 255, 255, 0.06); }
  .move-cell.empty { pointer-events: none; background: transparent; border-color: transparent; box-shadow: none; }

  .move-num { color: rgba(232, 232, 208, 0.72); font-size: 0.78em; font-weight: 700; padding: 0.15rem 0.45rem; border-radius: 999px; background: rgba(0, 0, 0, 0.16); }
  .move-san-text { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acc-badge { width: 20px; height: 20px; border-radius: 50%; margin-left: 2px; }

  /* --- Share & Toasts --- */
  .sharebar { display: flex; justify-content: center; gap: 0.6rem; margin-top: 0.9rem; padding: 0 1rem; }
  .sharebtn { background: rgba(0, 0, 0, 0.22); color: #f4f0e3; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; padding: 0.4rem 0.8rem; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
  .sharebtn:hover { background: rgba(103, 122, 228, 0.3); }

  .toast {
    position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); background: rgba(20, 20, 20, 0.92);
    color: #f4f0e3; padding: 0.6rem 1.2rem; border-radius: 999px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); z-index: 1000;
  }
  .toast-fade-enter-active, .toast-fade-leave-active { transition: opacity 0.25s ease, transform 0.25s ease; }
  .toast-fade-enter-from, .toast-fade-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }
</style>