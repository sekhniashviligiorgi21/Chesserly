<script setup>
  import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
  import { Chess } from 'chess.js'
  import { TheChessboard } from 'vue3-chessboard'
  import 'vue3-chessboard/style.css'
  import Title from "../assets/Title.vue"
  import SettingsPanel from "../assets/SettingsPanel.vue"
  import { startEngine, getEvaluation, cancelAnalysis } from "../engine/engine.js"
  import { useRoute } from 'vue-router'

  // Flag gates for preventing startup racing
  let boardReady = false
  let engineReady = false 

  onMounted(async () => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('click', closeContextMenu)
    window.addEventListener('scroll', closeContextMenu, true)
    reportTitle.value.style.backgroundColor = passiveColor.value
    await startEngine();
    engineReady = true
    if (!route.query.moves){
      await getAccuracy()
    } else {
      await tryLoadImportedGame()
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('click', closeContextMenu)
    window.removeEventListener('scroll', closeContextMenu, true)
    clearTimeout(toastTimeout)
    clearTimeout(longPressTimer)
  })

  // State
  const route = useRoute()
  const isSettingsOpen = ref(false)
  const isFlipped = computed(() => (rotate.value / 180) % 2 === 1)

  const chess = new Chess()
  const greedyChess = new Chess()
  const excellentChess = new Chess()
  const bestChess = new Chess()
  const thirdChess = new Chess()

  // Persist the user's chosen engine depth across route/component remounts
  // (Analysis.vue gets recreated whenever the router query changes, e.g. when
  // importing a game from Review.vue, which used to reset this back to 10)
  const DEPTH_STORAGE_KEY = 'chesslab_targetDepth'
  function loadStoredDepth() {
    const stored = Number(localStorage.getItem(DEPTH_STORAGE_KEY))
    return stored >= 10 && stored <= 30 ? stored : 10
  }

  const moveData = shallowRef(null)
  const boardAPI = shallowRef(null)
  const isAnalyzing = ref(false)
  const isImporting = ref(false)
  const importProgress = ref({ current: 0, total: 0 })
  const currentDepth = ref(10)
  const targetDepth = ref(loadStoredDepth())
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
  const displayMoves = ref(true)
  const contextMenu = ref({ visible: false, x: 0, y: 0, nodeId: null })

  // Imported player info (passed via router query from Review.vue)
  const whiteName = ref('White')
  const blackName = ref('Black')
  const whiteRating = ref(null)
  const blackRating = ref(null)
  const hasPlayerInfo = ref(false)

  if (route.query.white || route.query.black) {
    hasPlayerInfo.value = true
    if (route.query.white) whiteName.value = route.query.white
    if (route.query.black) blackName.value = route.query.black
    if (route.query.whiteRating) whiteRating.value = route.query.whiteRating
    if (route.query.blackRating) blackRating.value = route.query.blackRating
  }

  const topPlayer = computed(() => (
    isFlipped.value
      ? { name: whiteName.value, rating: whiteRating.value, side: 'white' }
      : { name: blackName.value, rating: blackRating.value, side: 'black' }
  ))

  const bottomPlayer = computed(() => (
    isFlipped.value
      ? { name: blackName.value, rating: blackRating.value, side: 'black' }
      : { name: whiteName.value, rating: whiteRating.value, side: 'white' }
  ))


  let longPressTimer = null
  let longPressTriggered = false
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
    analysisData: null, // New cache property
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

  const activeColor = ref('#5e3c20')
  const passiveColor = ref('#8d5b33')
  const movesTitle = ref(null)
  const reportTitle = ref(null)

  function changeActiveToMoves(){
    if (movesTitle.value){
      movesTitle.value.style.backgroundColor = activeColor.value
    }

    if (reportTitle.value){
     reportTitle.value.style.backgroundColor = passiveColor.value
    }
  }

  function changeActiveToReport(){
    if (reportTitle.value){
      reportTitle.value.style.backgroundColor = activeColor.value
    }

    if (movesTitle.value){
      movesTitle.value.style.backgroundColor = passiveColor.value
    }
  }

  function deleteMove(nodeId) {
    const node = nodeMap[nodeId]
    if (!node || node.parent === null) return // can't delete the root

    const parent = node.parent
    const idx = parent.children.indexOf(node)
    if (idx !== -1) parent.children.splice(idx, 1)

    // collect this node + all its descendants so we can purge them from nodeMap
    function collectIds(n, ids) {
      ids.push(n.id)
      for (const child of n.children) collectIds(child, ids)
      return ids
    }
    const idsToRemove = collectIds(node, [])
    const currentWasRemoved = idsToRemove.includes(currentNode.value.id)

    for (const id of idsToRemove) delete nodeMap[id]

    if (currentWasRemoved) {
      // board was sitting somewhere inside the deleted line — snap back to the parent
      jumpToNode(parent.id)
    } else {
      treeVersion.value++
    }
  }

  function showContextMenu(x, y, nodeId) {
    const menuWidth = 160
    const menuHeight = 44
    contextMenu.value = {
      visible: true,
      x: Math.min(x, window.innerWidth - menuWidth - 8),
      y: Math.min(y, window.innerHeight - menuHeight - 8),
      nodeId
    }
  }

  function closeContextMenu() {
    contextMenu.value.visible = false
  }

  function openContextMenu(event, nodeId) {
    showContextMenu(event.clientX, event.clientY, nodeId)
  }

  function handleDeleteFromMenu() {
    if (contextMenu.value.nodeId !== null) deleteMove(contextMenu.value.nodeId)
    closeContextMenu()
  }

  // Long-press for mobile
  function handleTouchStart(event, nodeId) {
    longPressTriggered = false
    longPressTimer = setTimeout(() => {
      longPressTriggered = true
      const touch = event.touches[0]
      showContextMenu(touch.clientX, touch.clientY, nodeId)
      if (navigator.vibrate) navigator.vibrate(10)
    }, 500)
  }

  function cancelLongPress() {
    clearTimeout(longPressTimer)
  }

  function handleCellClick(nodeId) {
    if (longPressTriggered) {
      longPressTriggered = false
      return
    }
    jumpToNode(nodeId)
  }

  // Audio Context management safely wrapped inside an explicit check
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

  // Arrow Drawing Logic
  function drawBestArrow() {
    if (!showBestArrow.value || !boardAPI.value || !bestArrowSquares.value) return
    const { from, to } = bestArrowSquares.value
    boardAPI.value.drawMove(from, to, 'green')
  }

  async function onBoardCreated(api) {
    boardAPI.value = api
    chess.reset()
    boardAPI.value.setPosition(chess.fen())
    boardReady = true
    await tryLoadImportedGame()
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
      id: nodeIdCounter++, san: sanMove.san, uci, fen: chess.fen(), accuracy: null, analysisData: null, parent: currentNode.value, children: []
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
    await cancelAnalysis() // Stop any running analysis first
    
    // --- CACHE CHECK ---
    const cached = currentNode.value.analysisData
    if (cached && cached.depth >= targetDepth.value) {
      // Restore from cache if the stored depth is sufficient
      moveData.value = cached
      lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
      lastMoveAccuracy.value = cached.move_accuracy
      currentDepth.value = cached.depth
      
      isAnalyzing.value = false
      if (showBestArrow.value && boardAPI.value) boardAPI.value.hideMoves()
      
      // Trigger UI updates
      if (typeof evalSize === "function") evalSize()
      if (typeof moveDescription === "function") moveDescription()
      if (typeof sanBest === "function") sanBest()
      if (typeof uciSecondLine === "function") uciSecondLine()
      if (typeof uciThirdLine === "function") uciThirdLine()
      if (typeof uciLine === "function") uciLine()
      drawBestArrow()
      
      treeVersion.value++
      return // Exit the function to prevent the engine from running
    }
    // -------------------

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
        currentNode.value.analysisData = result // <-- SAVE TO CACHE
        
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

  function onDepthChange() {
    localStorage.setItem(DEPTH_STORAGE_KEY, String(targetDepth.value))
    getAccuracy()
  }

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
          else { cp.value = -800; height.value = 100 }
          return
      }
      cp.value = Math.max(-800, Math.min(800, evalValue))
      // Scales exactly from 0% (full white) to 100% (full black)
      height.value = 50 - (cp.value / 800) * 50
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
    if (!square) return {}

    const file = square.charCodeAt(0) - 97
    const rank = parseInt(square[1]) - 1
    const isFlipped = (rotate.value / 180) % 2 === 1

    const col = isFlipped ? 7 - file : file
    const row = isFlipped ? rank : 7 - rank

    // Each square is exactly 12.5% of the board's width/height.
    // (col + 1) aligns to the right edge of the square; row aligns to the top edge.
    return {
        position: 'absolute',
        left: `${(col + 1) * 12.5}%`,
        top: `${row * 12.5}%`,  
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
      if (isImporting.value) return // don't let the user jump around the tree while the engine is chewing through an imported game

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

  // Game report logic
  async function loadImportedGame(uciList) {
    isImporting.value = true
    importProgress.value = { current: 0, total: uciList.length }
    try {
      for (const uci of uciList) {
        const result = applyUciMove(uci)
        if (!result) break
        boardAPI.value.setPosition(chess.fen())
        await getAccuracy()
        importProgress.value.current++
      }
      goToStart()
    } finally {
      isImporting.value = false
    }
  }

  async function tryLoadImportedGame() {
    if (boardReady && engineReady && route.query.moves) {
      const importedUciList = route.query.moves.split('-')
      await loadImportedGame(importedUciList)
    }
  }

  const classificationOrder = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder']

  const classificationMeta = {
    brilliant:  { label: 'Brilliant',  color: '#03aea7' },
    great:      { label: 'Great',      color: '#4c8cb5' },
    best:       { label: 'Best',       color: '#6ad13f' },
    excellent:  { label: 'Excellent',  color: '#90bc36' },
    good:       { label: 'Good',       color: '#8eae83' },
    book:       { label: 'Book',       color: '#ad8760' },
    inaccuracy: { label: 'Inaccuracy', color: '#f2bc43' },
    mistake:    { label: 'Mistake',    color: '#f38800' },
    blunder:    { label: 'Blunder',    color: '#FF0000' }
  }

  const accuracyWeights = {
    brilliant: 100, great: 100, best: 100, book: 100,
    excellent: 90, good: 80, inaccuracy: 20, mistake: 10, blunder: 0
  }

  const gameReportStats = computed(() => {
    treeVersion.value

    function emptyCounts() {
      return classificationOrder.reduce((acc, key) => ({ ...acc, [key]: 0 }), {})
    }

    const white = { counts: emptyCounts(), weightedSum: 0, moveCount: 0 }
    const black = { counts: emptyCounts(), weightedSum: 0, moveCount: 0 }

    let current = moveTree.children[0] ?? null
    let ply = 1 

    while (current) {
      const side = ply % 2 === 1 ? white : black

      if (current.accuracy && side.counts.hasOwnProperty(current.accuracy)) {
        side.counts[current.accuracy]++
        side.weightedSum += accuracyWeights[current.accuracy] ?? 0
        side.moveCount++
      }

      current = current.children[0] ?? null
      ply++
    }

    const finalize = (side) => ({
      counts: side.counts,
      accuracy: side.moveCount > 0 ? (side.weightedSum / side.moveCount) : null
    })

    return { white: finalize(white), black: finalize(black) }
  })

  const importProgressPercent = computed(() => {
    if (!importProgress.value.total) return 0
    return Math.round((importProgress.value.current / importProgress.value.total) * 100)
  })

</script>

<template>
  <!-- Main Settings Integration -->
  <SettingsPanel 
    v-model:isOpen="isSettingsOpen"
    v-model:targetDepth="targetDepth"
    v-model:soundOn="soundOn"
    v-model:showBestArrow="showBestArrow"
    @depthChanged="onDepthChange"
  />

  <Transition name="loading-fade">
    <div v-if="isImporting" class="analysis-loading-overlay">
      <div class="loading-content">
        <div class="loading-spinner">
          <div class="spinner-ring"></div>
          <div class="spinner-ring"></div>
          <div class="spinner-ring"></div>
        </div>
        <p class="loading-title">Analyzing Game</p>
        <p class="loading-subtitle">Move {{ importProgress.current }} / {{ importProgress.total }} · Depth {{ targetDepth }}</p>
        <div class="loading-progress-bar">
          <div class="loading-progress-fill" :style="{ width: importProgressPercent + '%' }"></div>
        </div>
      </div>
    </div>
  </Transition>

  <div class="grid-layout">
    <Title class="title-slot"/>
    <div class="board-area">
      <div class="board-wrapper" ref="boardRef">
        <div class="player-bar" v-if="hasPlayerInfo">
          <span class="player-color-dot" :class="topPlayer.side"></span>
          <span class="player-name">{{ topPlayer.name }}</span>
          <span class="player-rating" v-if="topPlayer.rating">{{ topPlayer.rating }}</span>
        </div>
        
        <div class="board-row">
          <div class="board-col">
            <!-- Added specific class to handle overflow bounds -->
            <TheChessboard 
              class="game-board"
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
          
          <div class="evalbar">
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
        </div>

        <div class="player-bar bottom" v-if="hasPlayerInfo">
          <span class="player-color-dot" :class="bottomPlayer.side"></span>
          <span class="player-name">{{ bottomPlayer.name }}</span>
          <span class="player-rating" v-if="bottomPlayer.rating">{{ bottomPlayer.rating }}</span>
        </div>
        
        <div class="boardtools">
          <button class="jumpstart" @click="goToStart" :disabled="isImporting || currentNode.parent === null" title="Jump to start">⏮</button>
          <button class="undo" @click="undoAccuracy" title="previous" :disabled="isImporting || currentNode.parent === null">↶</button>
          <button class="reverse" @click="flipBoard" title="flip board">↳↰</button>
          <button class="redo" title="next" @click="redoAccuracy" :disabled="isImporting || currentNode.children.length === 0">↷</button>
          <button class="jumpend" @click="goToEnd" :disabled="isImporting || currentNode.children.length === 0" title="Jump to end">⏭</button>
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
        <div class="movesButtons">
          <button class="movehistory" @click="displayMoves=true; changeActiveToMoves()" ref="movesTitle">Moves</button>
          <button class="movehistory" @click="displayMoves=false; changeActiveToReport()" ref="reportTitle">Report</button>
        </div>
        <div class="moveslist" v-if="displayMoves" ref="movesListRef">
          <template v-for="row in renderedMoves" :key="row.key">
            <div class="move-row" :class="{ variant: row.depth > 0 }" :style="{ '--indent': `${row.depth * 1.05}rem` }">
              <div
                v-for="(cell, index) in row.cells"
                :key="cell ? cell.key : `${row.key}-empty-${index}`"
                class="move-cell"
                :class="[{ active: cell && cell.node === currentNode, variant: cell && cell.variant }, { empty: !cell }]"
                @click="cell && handleCellClick(cell.node.id)"
                @contextmenu.prevent="cell && openContextMenu($event, cell.node.id)"
                @touchstart="cell && handleTouchStart($event, cell.node.id)"
                @touchend="cancelLongPress"
                @touchmove="cancelLongPress"
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
      <div class="report" v-else-if="!displayMoves">
        <div class="report-columns">
          <div class="report-col">
            <div class="report-side-header">
              <span class="side-swatch white-swatch"></span>
              <span>White</span>
            </div>
            <div class="accuracy-score" v-if="gameReportStats.white.accuracy !== null">
              {{ gameReportStats.white.accuracy.toFixed(1) }}<span class="accuracy-percent">%</span>
            </div>
            <div class="accuracy-score empty" v-else>—</div>

            <div
              v-for="key in classificationOrder"
              :key="'w-' + key"
              class="report-row"
              :class="{ dim: gameReportStats.white.counts[key] === 0 }"
            >
              <img :src="accuracySymbol(key)" class="report-row-icon" />
              <span class="report-row-label" :style="{ color: classificationMeta[key].color }">{{ classificationMeta[key].label }}</span>
              <span class="report-row-count">{{ gameReportStats.white.counts[key] }}</span>
            </div>
          </div>

          <div class="report-col">
            <div class="report-side-header">
              <span class="side-swatch black-swatch"></span>
              <span>Black</span>
            </div>
            <div class="accuracy-score" v-if="gameReportStats.black.accuracy !== null">
              {{ gameReportStats.black.accuracy.toFixed(1) }}<span class="accuracy-percent">%</span>
            </div>
            <div class="accuracy-score empty" v-else>—</div>

            <div
              v-for="key in classificationOrder"
              :key="'b-' + key"
              class="report-row"
              :class="{ dim: gameReportStats.black.counts[key] === 0 }"
            >
              <img :src="accuracySymbol(key)" class="report-row-icon" />
              <span class="report-row-label" :style="{ color: classificationMeta[key].color }">{{ classificationMeta[key].label }}</span>
              <span class="report-row-count">{{ gameReportStats.black.counts[key] }}</span>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="contextMenu.visible"
      class="context-menu"
      :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
      @click.stop
    >
      <button class="context-menu-item delete" @click="handleDeleteFromMenu">
        Delete move
      </button>
    </div>
  </Teleport>

  <Transition name="toast-fade">
    <div v-if="toastMessage" class="toast">{{ toastMessage }}</div>
  </Transition>
</template>

<style scoped>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600;700&display=swap');

  .grid-layout {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    padding: clamp(0.5rem, 3vw, 1rem);
    display: grid;
    grid-template-columns: 1fr;
    grid-template-areas:
      "title"
      "board"
      "analysis";
    gap: 1.5rem;
    max-width: 1600px;
    margin: 0 auto;
    box-sizing: border-box;
  }

  @media (min-width: 768px) {
    .grid-layout {
      grid-template-columns: auto 1fr;
      grid-template-areas:
        "title board"
        "title analysis";
      gap: 1rem;
    }
  }

  @media (min-width: 1200px) {
    .grid-layout {
      grid-template-columns: auto 2fr 1fr;
      grid-template-areas: "title board analysis";
      gap: 2rem;
    }
  }

  .title-slot { grid-area: title; min-width: 0; }

  .board-area {
    grid-area: board;
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
  }

  .board-wrapper {
    position: relative;
    width: 100%;
    /* Controls the master width for the board, evalbar, AND tools together */
    max-width: min(95vw, 38rem); 
    min-width: 0;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  }

  .board-col {
    flex: 1 1 auto;
    min-width: 0;
    position: relative;
    display: flex;             /* Makes the board fit exact bounds */
    flex-direction: column;    /* Removes invisible trailing vertical space */
  }

  /* Force the library container instance to fit perfectly within the flex column boundaries */
  .game-board {
    width: 100% !important;
    height: auto !important;
    aspect-ratio: 1 / 1 !important;
    display: block;
  }

  /* Constrain the inner chessground wrapper element to match the layout parent */
  :deep(.cg-wrap) {
    overflow: hidden;
    width: 100% !important;
    height: 100% !important;
    box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4);
    border-radius: 8px;
  }

  .board-row {
    display: flex;
    justify-content: center;
    gap: 0.75rem; /* physical gap separation */
    width: 100%;
  }

  .evalbar {
    width: clamp(24px, 4vw, 40px);
    flex-shrink: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .evalbar-inner {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
  }

  /* --- Player bar (imported game info) --- */
  .player-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.7rem;
    margin-bottom: 0.2rem;      /* Tighter gap to the board */
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.22);
    color: #f4f0e3;
    font-family: 'Inter', sans-serif;
    font-size: clamp(0.82rem, 1.8vw, 0.95rem);
    width: 100%;                /* Forces parallel alignment */
    box-sizing: border-box;
  }

  /* Specific spacing for the bottom player name */
  .player-bar.bottom {
    margin-bottom: 0;
    margin-top: 0.2rem;         /* Pulls it up close to the evalbar bottom */
  }

  .player-color-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
  }

  .player-color-dot.white { background: #f4f0e3; }
  .player-color-dot.black { background: #1a1a1a; }

  .player-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .player-rating {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.8em;
    color: rgba(244, 240, 227, 0.75);
    margin-left: auto;
    background: rgba(0, 0, 0, 0.25);
    border-radius: 6px;
    padding: 0.05rem 0.4rem;
    flex-shrink: 0;
  }

  /* Moves History Layout */
  .moves {
    margin-top: 10px;
    background: linear-gradient(145deg, #8b5a32, #6d4524);
    border-radius: 16px;
    width: 100%;
    max-width: 500px;
    height: clamp(300px, 50vh, 500px);
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    overflow-y: auto;
    overflow-x: hidden;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin: 0 auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(194, 197, 170, 0.4) rgba(0, 0, 0, 0.2);
  }

  @media (min-width: 1200px) { .moves { max-width: 20rem; } }

  .moveslist {
    margin: 0 auto;
    padding: 12px;
    width: 100%;
    box-sizing: border-box;
    background: linear-gradient(135deg, #a57548, #7d5530);
    border-radius: 14px;
    font-size: clamp(0.9rem, 2vw, 1rem);
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    scroll-behavior: smooth;
  }

  .movesButtons{
    display: flex;
    justify-content: center;
    gap: 0.5rem;
  }

  .move-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    align-items: start;
    margin-left: var(--indent, 0rem);
    padding-left: 0.35rem;
    position: relative;
  }

  .move-row.variant { border-left: 2px solid rgba(232, 232, 208, 0.16); }

  .move-cell {
    min-height: 2.45rem;
    padding: 0.55rem 0.7rem;
    border-radius: 12px;
    cursor: pointer;
    color: #f4f0e3;
    font-weight: 500;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
    background: rgba(0, 0, 0, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.06);
    box-sizing: border-box;
    overflow: hidden;
    -webkit-user-select: none;
    user-select: none;
  }

  .move-cell:hover {
    background: rgba(103, 122, 228, 0.18);
    transform: translateY(-1px);
  }

  .move-cell.active {
    background: linear-gradient(135deg, rgba(103, 122, 228, 0.42), rgba(103, 122, 228, 0.22));
    border-color: rgba(220, 228, 255, 0.7);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 18px rgba(103, 122, 228, 0.25);
  }

  .move-cell.variant { color: #dbe4ff; background: rgba(255, 255, 255, 0.06); }
  .move-cell.empty { pointer-events: none; background: transparent; border-color: transparent; box-shadow: none; }

  .move-num {
    color: rgba(232, 232, 208, 0.72);
    font-size: 0.78em;
    font-weight: 700;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.16);
  }

  .move-san-text { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acc-badge { width: 20px; height: 20px; border-radius: 50%; margin-left: 2px; }

  .analysis-container { grid-area: analysis; display: flex; flex-direction: column; gap: 1rem; min-width: 0; }

  .analyze {
    border-radius: 15px;
    width: 100%;
    max-width: 500px;
    min-height: 200px;
    padding-bottom: 1rem;
    background: linear-gradient(145deg, #8b5a32, #6d4524);
    box-sizing: border-box;
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin: auto;
  }

  @media (min-width: 1200px) { .analyze { max-width: 20rem; } }

  .analyzis-header {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 3rem;
    padding: 1rem 1rem 0.5rem;
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
    flex-shrink: 0;
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

  /* --- Import / Analysis Loading Overlay --- */
  .analysis-loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 10, 6, 0.25);
    backdrop-filter: blur(4px) saturate(105%);
    -webkit-backdrop-filter: blur(4px) saturate(105%);
  }

  .loading-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
    padding: 2rem 2.5rem;
    background: linear-gradient(145deg, rgba(94, 60, 32, 0.92), rgba(45, 28, 15, 0.92));
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 18px;
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.5);
  }

  .loading-spinner {
    position: relative;
    width: 64px;
    height: 64px;
  }

  .spinner-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 3px solid transparent;
    border-top-color: #d9b382;
    animation: spinRing 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }

  .spinner-ring:nth-child(2) {
    inset: 8px;
    border-top-color: #a8d97a;
    animation-duration: 1.6s;
    animation-direction: reverse;
  }

  .spinner-ring:nth-child(3) {
    inset: 16px;
    border-top-color: #f4f0e3;
    animation-duration: 2s;
  }

  @keyframes spinRing { to { transform: rotate(360deg); } }

  .loading-title {
    font-family: serif;
    color: #f5f5dc;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    font-size: 1.05rem;
    margin: 0;
    text-align: center;
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
  }

  .loading-subtitle {
    font-family: "JetBrains Mono", monospace;
    color: rgba(244, 240, 227, 0.8);
    font-size: 0.82rem;
    margin: 0;
    text-align: center;
  }

  .loading-progress-bar {
    width: 180px;
    height: 5px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.35);
    overflow: hidden;
    margin-top: 0.2rem;
  }

  .loading-progress-fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #d9b382, #a8d97a);
    transition: width 0.3s ease;
  }

  .loading-fade-enter-active, .loading-fade-leave-active {
    transition: opacity 0.35s ease;
  }

  .loading-fade-enter-from, .loading-fade-leave-to {
    opacity: 0;
  }

  .movehistory {
    font-family: serif;
    position: sticky;
    text-align: center;
    color: #f5f5dc;
    font-weight: 700;
    text-transform: uppercase;
    margin: 20px 0;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
    letter-spacing: 2.5px;
    padding: 0.5rem 1.5rem;
    border-radius: 5px;
    background-color: #5e3c20;
    border: none;
    font-size: clamp(1rem, 2vw, 1.2rem);
  }

  .boardtools {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    align-items: center;
    min-height: 3.2rem;
    width: 100%;  
    box-sizing: border-box;
    background: linear-gradient(145deg, #8b5a32, #6d4524);
    border: 2px solid rgba(182, 173, 144, 0.4);
    padding: 0.5rem 1rem;
    border-radius: 10px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    margin: 0.4rem 0 0 0;  
    flex-wrap: wrap;
    position: relative;
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

  /* --- Navigation & Control Buttons --- */
  .reverse:disabled, 
  .undo:disabled, 
  .redo:disabled, 
  .jumpstart:disabled, 
  .jumpend:disabled {
      opacity: 0.4;
      cursor: not-allowed;
  }

  .reversetip, .undotip, .redotip, .resettip {
      display: none;
  }

  @media (min-width: 768px) {
      .reversetip, .undotip, .redotip, .resettip {
          display: block;
          opacity: 0;
          position: absolute;
          font-size: clamp(14px, 2vw, 17px);
          padding: 0.5rem;
          border-radius: 10px;
          background-color: #242424;
          margin-top: -4.5rem;
          transform: translateX(-50%);
          left: 50%;
          pointer-events: none;
      }

      .reverse:hover + .reversetip, 
      .undo:hover + .undotip, 
      .redo:hover + .redotip, 
      .reset:hover + .resettip {
          animation: fadeIn 0.4s forwards 0.3s;
      }
  }

  .reverse:hover:not(:disabled), 
  .undo:hover:not(:disabled), 
  .redo:hover:not(:disabled), 
  .reset:hover, 
  .jumpstart:hover:not(:disabled), 
  .jumpend:hover:not(:disabled) {
      background: linear-gradient(145deg, #9d6640, #7d5530);
      border-color: rgba(232, 232, 208, 0.6);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 0.8; }
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
      font-size: clamp(0.8rem, 1.2vw, 1rem);
      font-weight: 500;
      color: #fff8ef;
      text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.6);
      background: rgba(0, 0, 0, 0.3);
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      backdrop-filter: blur(4px);
      z-index: 10;
  }

/* --- Move & Accuracy Data --- */
  .accuracydescribtion {
      font-weight: 500;
      text-align: center;
      font-size: clamp(1rem, 2.1vw, 1.2rem);
      margin-top: 1rem;
      padding: 0 1rem;
      word-wrap: break-word;
  }

  .bestmove {
      color: #41a24e;
      text-align: center;
      font-weight: 600;
      margin-top: 0.1rem;
      font-size: clamp(0.9rem, 1rem, 1.1rem);
      padding: 0 1rem;
      cursor: pointer;
      text-decoration: underline;
  }

  .move-data { padding: 0 1rem; }

  .depthnum {
      font-family: 'Inter', sans-serif;
      text-align: center;
      color: rgba(245, 245, 220, 0.7);
      font-size: 0.78rem;
      font-weight: 600;
      text-transform: uppercase;
      margin: 0.3rem 0 0.5rem;
  }

  .line, .secondline {
      font-family: "JetBrains Mono", monospace;
      display: flex;
      white-space: nowrap;
      align-items: center;
      gap: 0.5rem;
      font-size: clamp(0.85rem, 2vw, 1rem);
      padding: 0.5rem;
      margin: 8px 0;
      background: rgba(0, 0, 0, 0.25);
      border-radius: 10px;
      color: #eae4d8;
      box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.4);
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(0, 0, 0, 0.3)  rgba(0, 0, 0, 0.1); 
  }

  .evalnum2, .evalnum3 {
      font-size: clamp(1rem, 2vw, 1.3rem);
      color: #171717;
      background-color: #606847;
      border-radius: 10px;
      flex-shrink: 0;
      width: 4.4rem;
      text-align: center;
  }

  .board-acc-icon {
      position: absolute;
      width: 4.5%;
      height: 4.5%;
      border-radius: 50%;
      pointer-events: none;
  }

  .line-move { cursor: pointer; padding: 0 2px; border-radius: 4px; }
  .line-move:hover { background: rgba(103, 122, 228, 0.3); }

  /* --- Share & Toasts --- */
  .sharebar {
      display: flex;
      justify-content: center;
      gap: 0.6rem;
      margin-top: 0.9rem;
      padding: 0 1rem;
  }

  .sharebtn {
      background: rgba(0, 0, 0, 0.22);
      color: #f4f0e3;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 0.4rem 0.8rem;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
  }

  .sharebtn:hover { background: rgba(103, 122, 228, 0.3); }

  .toast {
      position: fixed;
      bottom: 1.5rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(20, 20, 20, 0.92);
      color: #f4f0e3;
      padding: 0.6rem 1.2rem;
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      z-index: 1000;
  }

  .toast-fade-enter-active, .toast-fade-leave-active {
      transition: opacity 0.25s ease, transform 0.25s ease;
  }

  .toast-fade-enter-from, .toast-fade-leave-to {
      opacity: 0;
      transform: translateX(-50%) translateY(8px);
  }

  .context-menu {
    position: fixed;
    z-index: 2000;
    background: #2a2a2a;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    min-width: 140px;
  }

  .context-menu-item {
    display: block;
    width: 100%;
    padding: 0.65rem 1rem;
    background: transparent;
    border: none;
    color: #f4f0e3;
    font-size: 0.9rem;
    text-align: left;
    cursor: pointer;
  }

  .context-menu-item.delete { color: #ff6b6b; }
  .context-menu-item.delete:hover { background: rgba(255, 60, 60, 0.2); }

  .report {
    padding: 1rem;
    box-sizing: border-box;
  }

  .report-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }

  .report-col {
    min-width: 0;
    background: linear-gradient(135deg, #a57548, #7d5530);
    border-radius: 14px;
    padding: 0.8rem 0.5rem;
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
    box-sizing: border-box;
  }

  .report-side-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    font-family: serif;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: #f5f5dc;
    font-size: 0.78rem;
    margin-bottom: 0.5rem;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
  }

  .side-swatch {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
    display: inline-block;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
    flex-shrink: 0;
  }

  .white-swatch { background: #f4f0e3; }
  .black-swatch { background: #1a1a1a; }

  .accuracy-score {
    font-family: "JetBrains Mono", monospace;
    font-size: clamp(1.3rem, 6vw, 1.8rem);
    font-weight: 700;
    color: #a8d97a;
    text-align: center;
    margin: 0.4rem 0 0.7rem;
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  }

  .accuracy-score.empty {
    color: rgba(245, 245, 220, 0.4);
    font-size: 1.2rem;
  }

  .accuracy-percent {
    font-size: 0.6em;
    opacity: 0.75;
  }

  .report-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.3rem;
    border-radius: 8px;
    transition: background 0.15s ease;
    min-width: 0;
  }

  .report-row:hover {
    background: rgba(0, 0, 0, 0.12);
  }

  .report-row.dim {
    opacity: 0.35;
  }

  .report-row-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .report-row-label {
    flex: 1;
    font-size: 0.76rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .report-row-count {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    color: #f4f0e3;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 6px;
    padding: 0.05rem 0.4rem;
    font-size: 0.76rem;
    min-width: 1.3rem;
    text-align: center;
    flex-shrink: 0;
  }
</style>