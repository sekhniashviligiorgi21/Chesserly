<script setup>
  import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
  import { Chess } from 'chess.js'
  import { TheChessboard } from 'vue3-chessboard'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { collection, addDoc, serverTimestamp, query, where, getDocs, updateDoc, doc } from 'firebase/firestore'
  import 'vue3-chessboard/style.css'
  import Title from "../assets/Title.vue"
  import SettingsPanel from "../assets/SettingsPanel.vue"
  import { startEngine, getEvaluation, cancelAnalysis } from "../engine/engine.js"
  import { useRoute, useRouter } from 'vue-router'

  const currentTheme = ref(localStorage.getItem('chesslab_theme') || 'brown')
  watch(currentTheme, (newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('chesslab_theme', newTheme)
  }, { immediate: true })

  let boardReady = false
  let engineReady = false

  onMounted(async () => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('click', closeContextMenu)
    window.addEventListener('scroll', closeContextMenu, true)

    activeTab.value = 'moves'

    await startEngine()
    engineReady = true

    if (route.query.fen) {
      await loadFen(route.query.fen)
      await getAccuracy()
    } else if (route.query.moves) {
      await tryLoadImportedGame()
    } else {
      await getAccuracy()
    }
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('click', closeContextMenu)
    window.removeEventListener('scroll', closeContextMenu, true)
    clearTimeout(toastTimeout)
    clearTimeout(longPressTimer)
  })

  const route = useRoute()
  const router = useRouter()
  const isSettingsOpen = ref(false)
  const isFlipped = computed(() => (rotate.value / 180) % 2 === 1)

  const chess = new Chess()
  const greedyChess = new Chess()
  const excellentChess = new Chess()
  const bestChess = new Chess()
  const thirdChess = new Chess()

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
  let importCancelled = false
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
  const lastMoveFromSquare = ref(null)
  const lastMoveAccuracy = ref(null)
  const boardRef = ref(null)
  const movesListRef = ref(null)
  const thirdSanLine = ref([])
  const soundOn = ref(true)
  const showBestArrow = ref(true)
  const bestArrowSquares = ref(null)
  const toastMessage = ref('')
  const activeTab = ref('moves')
  const contextMenu = ref({ visible: false, x: 0, y: 0, nodeId: null })
  const shareMenuOpen = ref(false)

  const whiteName = ref('White')
  const blackName = ref('Black')
  const whiteRating = ref(null)
  const blackRating = ref(null)
  const hasPlayerInfo = ref(false)

  const gameResult = ref(null)
  if (route.query.pgn) {
    const match = route.query.pgn.match(/\[Result\s+"([^"]+)"\]/)
    if (match) gameResult.value = match[1]
  }

  const opening = ref("")
  const openingEco = ref("")

  const explorerStats = shallowRef(null)
  const explorerMoves = shallowRef([])
  const explorerLoading = ref(false)
  const explorerError = ref("")
  const explorerDb = ref('masters')

  // Accuracy classification colors, reused both for the move-description text
  // and for the CSS variable that tints the actual chessground last-move squares.
  const accuracyColors = {
    brilliant: '#03aea7', great: '#4c8cb5', best: '#6ad13f', excellent: '#90bc36',
    good: '#8eae83', book: '#ad8760', inaccuracy: '#f2bc43', mistake: '#f38800', blunder: '#FF0000'
  }
  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.replace('#', ''), 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const lastMoveHighlightColor = computed(() => {
    const c = accuracyColors[lastMoveAccuracy.value]
    return c ? hexToRgba(c, 0.35) : null
  })

  // Keep chessground's own last-move squares in sync with our from/to state.
  // We drive the board via setPosition() rather than its internal move engine,
  // so chessground won't know the last move on its own — setConfig({ lastMove }) is the
  // supported way to tell it which real board squares to highlight.
  watch([lastMoveFromSquare, lastMoveSquare], ([from, to]) => {
    if (!boardAPI.value) return
    boardAPI.value.setConfig({ lastMove: from && to ? [from, to] : undefined })
  })

  function isExplorerOutOfBook(node, db) {
    let n = node
    while (n) {
      if (n.explorerOutOfBook && n.explorerOutOfBook[db]) return true
      n = n.parent
    }
    return false
  }

  function markNodeOutOfBook(db) {
    if (!currentNode.value.explorerOutOfBook) currentNode.value.explorerOutOfBook = {}
    currentNode.value.explorerOutOfBook[db] = true
  }

  function getLastOpening(node) {
    let n = node
    while (n) {
      if (n.lastOpening) return n.lastOpening
      n = n.parent
    }
    return null
  }

  async function importLichessExplorer() {
    if (isExplorerOutOfBook(currentNode.value, explorerDb.value)) {
      const last = getLastOpening(currentNode.value)
      if (last) {
        opening.value = last.name
        openingEco.value = last.eco
      } else {
        opening.value = movesListUCI.value.length === 0 ? "Starting position" : "Out of book"
        openingEco.value = ""
      }
      explorerStats.value = null
      explorerMoves.value = []
      explorerError.value = ""
      explorerLoading.value = false
      return
    }

    explorerLoading.value = true
    explorerError.value = ""
    const uciList = movesListUCI.value

    if (uciList.length > 40) {
      markNodeOutOfBook(explorerDb.value)
      const last = getLastOpening(currentNode.value)
      if (last) {
        opening.value = last.name
        openingEco.value = last.eco
      } else {
        opening.value = `${explorerDb.value === 'masters' ? 'Master' : 'Player'} games limit reached (max 40 moves)`
        openingEco.value = ""
      }
      explorerLoading.value = false
      return
    }

    const bookList = uciList.join(",")
    const dbParam = explorerDb.value
    const url = bookList
      ? `../../api/explorer?db=${dbParam}&play=${encodeURIComponent(bookList)}`
      : `../../api/explorer?db=${dbParam}`

    try {
      const response = await fetch(url)

      if (response.status === 204) {
        markNodeOutOfBook(explorerDb.value)
        const last = getLastOpening(currentNode.value)
        if (last) {
          opening.value = last.name
          openingEco.value = last.eco
        } else {
          opening.value = `No ${explorerDb.value === 'masters' ? 'master' : 'player'} games at this position`
          openingEco.value = ""
        }
        explorerStats.value = null
        explorerMoves.value = []
        explorerError.value = ""
        return
      }

      if (!response.ok) {
        explorerError.value = `Explorer error (${response.status})`
        explorerStats.value = null
        explorerMoves.value = []
        return
      }

      const data = await response.json()

      if (data.opening) {
        opening.value = data.opening.name
        openingEco.value = data.opening.eco
        // Persist the opening on this node so descendants that go out of book can recall it
        currentNode.value.lastOpening = {
          name: data.opening.name,
          eco: data.opening.eco
        }
      } else {
        // No opening classified for this position - fall back to the most recent known opening
        const last = getLastOpening(currentNode.value.parent)
        if (last) {
          opening.value = last.name
          openingEco.value = last.eco
        } else {
          opening.value = uciList.length === 0 ? "Starting position" : "Out of book"
          openingEco.value = ""
        }
      }

      const total = (data.white ?? 0) + (data.draws ?? 0) + (data.black ?? 0)

      if (total === 0 && uciList.length > 0) {
        markNodeOutOfBook(explorerDb.value)
      }

      explorerStats.value = total > 0 ? {
        white: Math.round((data.white / total) * 100),
        draws: Math.round((data.draws / total) * 100),
        black: Math.round((data.black / total) * 100),
        total
      } : null

      explorerMoves.value = (data.moves ?? [])
        .map(m => {
          const moveTotal = (m.white ?? 0) + (m.draws ?? 0) + (m.black ?? 0)
          return {
            san: m.san, uci: m.uci, total: moveTotal,
            percent: total > 0 ? Math.round((moveTotal / total) * 100) : 0,
            white: moveTotal > 0 ? Math.round((m.white / moveTotal) * 100) : 0,
            draws: moveTotal > 0 ? Math.round((m.draws / moveTotal) * 100) : 0,
            black: moveTotal > 0 ? Math.round((m.black / moveTotal) * 100) : 0,
          }
        })
        .sort((a, b) => b.total - a.total)

      explorerError.value = ""
    } catch (error) {
      console.warn("Explorer fetch failed:", error)
      explorerError.value = "No connection to explorer"
      explorerStats.value = null
      explorerMoves.value = []
    } finally {
      explorerLoading.value = false
    }
  }
  function playExplorerMove(uci) {
    const result = applyUciMove(uci)
    if (!result) return
    soundForLastMove(result)
    boardAPI.value.setPosition(chess.fen())
    getAccuracy()
  }

  if (route.query.white || route.query.black) {
    hasPlayerInfo.value = true
    if (route.query.white) whiteName.value = route.query.white
    if (route.query.black) blackName.value = route.query.black
    if (route.query.whiteRating) whiteRating.value = route.query.whiteRating
    if (route.query.blackRating) blackRating.value = route.query.blackRating
  }

  const isWhiteWinner = computed(() => gameResult.value === '1-0')
  const isBlackWinner = computed(() => gameResult.value === '0-1')

  const topPlayer = computed(() => {
    const isWhite = isFlipped.value
    return {
      name: isWhite ? whiteName.value : blackName.value,
      rating: isWhite ? whiteRating.value : blackRating.value,
      side: isWhite ? 'white' : 'black',
      isWinner: isWhite ? isWhiteWinner.value : isBlackWinner.value
    }
  })

  const bottomPlayer = computed(() => {
    const isWhite = !isFlipped.value
    return {
      name: isWhite ? whiteName.value : blackName.value,
      rating: isWhite ? whiteRating.value : blackRating.value,
      side: isWhite ? 'white' : 'black',
      isWinner: isWhite ? isWhiteWinner.value : isBlackWinner.value
    }
  })

  let longPressTimer = null
  let longPressTriggered = false
  let toastTimeout = null
  let audioCtx = null
  let lastPress = 0

  const moveTree = {
    id: 0, san: null, uci: null, fen: chess.fen(),
    accuracy: null, analysisData: null, parent: null, children: []
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
        key: `cell-${node.id}`, node,
        displayNum: Math.ceil(moveNum / 2),
        isWhite, showNum: isWhite || showAsStart, variant: depth > 0
      }
    }
    function walk(startNode, moveNum, depth = 0, isStartOfLine = true) {
      let current = startNode
      let ply = moveNum
      let firstRow = true
      if (!current.san) {
        if (current.children.length === 0) return
        walk(current.children[0], ply, depth, isStartOfLine)
        for (const variant of current.children.slice(1)) walk(variant, ply, depth + 1, true)
        return
      }
      while (current) {
        const mainReply = current.children[0] ?? null
        rows.push({
          key: `row-${current.id}`, depth,
          cells: [
            makeCell(current, ply, firstRow && isStartOfLine, depth),
            mainReply ? makeCell(mainReply, ply + 1, false, depth) : null
          ]
        })
        for (const variant of current.children.slice(1)) walk(variant, ply + 1, depth + 1, true)
        if (mainReply) for (const variant of mainReply.children.slice(1)) walk(variant, ply + 2, depth + 1, true)
        if (!mainReply) break
        current = mainReply.children[0] ?? null
        ply += 2
        firstRow = false
      }
    }
    walk(moveTree, 1)
    return rows
  })

  function deleteMove(nodeId) {
    const node = nodeMap[nodeId]
    if (!node || node.parent === null) return
    const parent = node.parent
    const idx = parent.children.indexOf(node)
    if (idx !== -1) parent.children.splice(idx, 1)
    function collectIds(n, ids) { ids.push(n.id); for (const child of n.children) collectIds(child, ids); return ids }
    const idsToRemove = collectIds(node, [])
    const currentWasRemoved = idsToRemove.includes(currentNode.value.id)
    for (const id of idsToRemove) delete nodeMap[id]
    treeVersion.value++
    if (currentWasRemoved) jumpToNode(parent.id)
  }

  function showContextMenu(x, y, nodeId) {
    const menuWidth = 160, menuHeight = 44
    contextMenu.value = {
      visible: true,
      x: Math.min(x, window.innerWidth - menuWidth - 8),
      y: Math.min(y, window.innerHeight - menuHeight - 8),
      nodeId
    }
  }
  function closeContextMenu() { contextMenu.value.visible = false; shareMenuOpen.value = false }
  function openContextMenu(event, nodeId) { showContextMenu(event.clientX, event.clientY, nodeId) }
  function handleDeleteFromMenu() {
    if (contextMenu.value.nodeId !== null) deleteMove(contextMenu.value.nodeId)
    closeContextMenu()
  }
  function handleTouchStart(event, nodeId) {
    longPressTriggered = false
    longPressTimer = setTimeout(() => {
      longPressTriggered = true
      const touch = event.touches[0]
      showContextMenu(touch.clientX, touch.clientY, nodeId)
      if (navigator.vibrate) navigator.vibrate(10)
    }, 500)
  }
  function cancelLongPress() { clearTimeout(longPressTimer) }
  function handleCellClick(nodeId) {
    if (longPressTriggered) { longPressTriggered = false; return }
    jumpToNode(nodeId)
  }

  function toggleShareMenu(event) {
    if (event) event.stopPropagation()
    shareMenuOpen.value = !shareMenuOpen.value
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
      osc.connect(gain); gain.connect(ctx.destination)
      const now = ctx.currentTime
      const presets = {
        move: { freq: 520, gain: 0.06, dur: 0.09 },
        capture: { freq: 260, gain: 0.10, dur: 0.14 },
        check: { freq: 880, gain: 0.10, dur: 0.20 },
      }
      const p = presets[type] ?? presets.move
      osc.type = type === 'capture' ? 'square' : 'sine'
      osc.frequency.setValueAtTime(p.freq, now)
      gain.gain.setValueAtTime(p.gain, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + p.dur)
      osc.start(now); osc.stop(now + p.dur + 0.02)
    } catch (e) {}
  }
  function soundForLastMove(sanMove) {
    if (chess.inCheck()) playSound('check')
    else if (sanMove?.captured) playSound('capture')
    else playSound('move')
  }

  watch(showBestArrow, (val) => {
    if (!val && boardAPI.value) boardAPI.value.hideMoves()
    else drawBestArrow()
  })
  watch(currentNode, () => { if (activeTab.value === 'explorer') importLichessExplorer() }, { immediate: true })
  watch(activeTab, (newTab) => { if (newTab === 'explorer') importLichessExplorer() })
  watch(explorerDb, () => { importLichessExplorer() })

  function showToast(message) {
    toastMessage.value = message
    clearTimeout(toastTimeout)
    toastTimeout = setTimeout(() => { toastMessage.value = '' }, 1800)
  }
  async function copyToClipboard(text, label) {
    try { await navigator.clipboard.writeText(text); showToast(`${label} copied to clipboard`) }
    catch (e) { showToast(`Couldn't copy ${label.toLowerCase()}`) }
  }
  function copyPGN() { copyToClipboard(chess.pgn() || '(no moves yet)', 'PGN') }
  function copyFEN() { copyToClipboard(chess.fen(), 'FEN') }

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
    let sanMove
    try { sanMove = chess.move({ from: move.from, to: move.to, promotion: move.promotion ?? undefined }) }
    catch (e) { sanMove = null }
    if (!sanMove) { boardAPI.value.setPosition(currentNode.value.fen); return }
    soundForLastMove(sanMove)
    const existing = currentNode.value.children.find(c => c.uci === uci)
    if (existing) { currentNode.value = existing }
    else {
      const newNode = {
        id: nodeIdCounter++, san: sanMove.san, uci, fen: chess.fen(),
        accuracy: null, analysisData: null, parent: currentNode.value, children: []
      }
      nodeMap[newNode.id] = newNode
      currentNode.value.children.push(newNode)
      currentNode.value = newNode
      treeVersion.value++
    }
    movesListUCI.value.push(uci)
    await getAccuracy()
  }

  function undoMove() {
    lastMoveSquare.value = null
    lastMoveFromSquare.value = null
    lastMoveAccuracy.value = null
    if (currentNode.value.parent === null) return
    chess.undo()
    currentNode.value = currentNode.value.parent
    movesListUCI.value.pop()
    boardAPI.value.setPosition(chess.fen())
  }
  function redoMove() {
    lastMoveSquare.value = null
    lastMoveFromSquare.value = null
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
  function undoAccuracy() { undoMove(); getAccuracy() }
  function redoAccuracy() { redoMove(); getAccuracy() }

  function jumpToNode(nodeId) {
    const node = nodeMap[nodeId]
    if (!node || node === currentNode.value) return
    const uciMoves = []
    let current = node
    while (current.parent !== null) { uciMoves.unshift(current.uci); current = current.parent }
    chess.reset()
    for (const uci of uciMoves) { try { chess.move(uci) } catch (e) { console.warn("Failed to apply UCI in jumpToNode", uci, e) } }
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
  function resetBoard() {
    chess.reset()
    boardAPI.value.setPosition(chess.fen())
    movesListUCI.value = []
    currentNode.value = moveTree
    moveTree.children = []
    moveTree.fen = chess.fen()
    nodeIdCounter = 1
    for (const key in nodeMap) if (parseInt(key) !== 0) delete nodeMap[key]
    treeVersion.value++
    getAccuracy()
  }
  function resetAccuracy() { resetBoard(); isAccuracy.value = ""; color.value = ""; moveData.value = null }

  async function getAccuracy() {
    await cancelAnalysis()
    const cached = currentNode.value.analysisData
    const requiresMultiPV3 = !isImporting.value
    const hasRequiredMultiPV = !requiresMultiPV3 || !currentNode.value.san || (cached?.topMoves?.length >= 3)

    if (cached && cached.depth >= targetDepth.value && hasRequiredMultiPV) {
      moveData.value = cached
      lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
      lastMoveFromSquare.value = movesListUCI.value.at(-1)?.slice(0, 2) ?? null
      lastMoveAccuracy.value = cached.move_accuracy
      currentDepth.value = cached.depth
      isAnalyzing.value = false
      if (showBestArrow.value && boardAPI.value) boardAPI.value.hideMoves()
      evalSize(); moveDescription(); sanBest(); uciSecondLine(); uciThirdLine(); uciLine(); drawBestArrow()
      return
    }
    if (cached && !hasRequiredMultiPV) {
      moveData.value = cached
      lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
      lastMoveFromSquare.value = movesListUCI.value.at(-1)?.slice(0, 2) ?? null
      lastMoveAccuracy.value = cached.move_accuracy
      currentDepth.value = cached.depth
      evalSize(); moveDescription(); sanBest(); uciSecondLine(); uciThirdLine(); uciLine(); drawBestArrow()
    }

    isAnalyzing.value = true
    bestArrowSquares.value = null
    if (showBestArrow.value && boardAPI.value) boardAPI.value.hideMoves()

    const beforeFen = currentNode.value.parent ? currentNode.value.parent.fen : moveTree.fen
    const afterFen = currentNode.value.fen

    await getEvaluation(
      movesListUCI.value.length === 0 ? '' : movesListUCI.value.at(-1),
      movesListUCI.value.slice(0, -1),
      targetDepth.value,
      (result) => {
        moveData.value = result
        lastMoveSquare.value = movesListUCI.value.at(-1)?.slice(2, 4) ?? null
        lastMoveFromSquare.value = movesListUCI.value.at(-1)?.slice(0, 2) ?? null
        lastMoveAccuracy.value = result.move_accuracy
        currentNode.value.accuracy = result.move_accuracy
        currentNode.value.analysisData = result
        currentDepth.value = result.depth
        isAnalyzing.value = false
        evalSize(); moveDescription(); sanBest(); uciSecondLine(); uciThirdLine(); uciLine(); drawBestArrow()
        if (!isImporting.value) treeVersion.value++
      },
      beforeFen, afterFen, moveTree.fen,
      isImporting.value ? 1 : 3
    )
  }

  function onDepthChange() { localStorage.setItem(DEPTH_STORAGE_KEY, String(targetDepth.value)); getAccuracy() }

  function formatEval(evalObj) {
    if (chess.isGameOver()) {
      if (chess.isCheckmate()) return chess.turn() === 'w' ? '0-1' : '1-0'
      if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition() || chess.isDraw()) return '1/2-1/2'
    }
    if (!evalObj) return ""
    if (evalObj.type === "cp") return (evalObj.value / 100).toFixed(2)
    if (evalObj.type === "mate") return `M${evalObj.value}`
    return ""
  }
  function evalSize() {
    if (!moveData.value || !moveData.value.eval) return
    const evalValue = moveData.value.eval.value
    const evalType = moveData.value.eval.type
    if (evalType === "mate") {
      if (evalValue >= 0) { cp.value = 800; height.value = 0 } else { cp.value = -800; height.value = 100 }
      return
    }
    cp.value = Math.max(-800, Math.min(800, evalValue))
    height.value = 50 - (cp.value / 800) * 50
  }
  function flipBoard() { boardAPI.value.toggleOrientation(); rotate.value += 180 }

  function accuracySymbol(acc) {
    const map = {
      brilliant: 'brilliant', best: 'best', excellent: 'excellent', good: 'good',
      inaccuracy: 'inaccuracy', mistake: 'mistake', blunder: 'blunder', great: 'great', book: 'book'
    }
    return map[acc] ? `/moveClassifications/${map[acc]}.png` : undefined
  }
  function moveDescription() {
    isAccuracy.value = ''
    if (!currentNode.value.san) return
    const descriptions = {
      great: { color: '#4c8cb5', text: ' is a great move!' },
      brilliant: { color: '#03aea7', text: ' is a brilliant move!!' },
      book: { color: '#ad8760', text: ' is a book move' },
      best: { color: '#6ad13f', text: ' is the best move' },
      excellent: { color: '#90bc36', text: ' is an excellent move' },
      good: { color: '#8eae83', text: ' is a good move' },
      inaccuracy: { color: '#f2bc43', text: ' is an inaccuracy' },
      mistake: { color: '#f38800', text: ' is a mistake' },
      blunder: { color: '#FF0000', text: ' is a blunder' },
    }
    const config = descriptions[moveData.value.move_accuracy]
    if (!config) return
    color.value = config.color
    isAccuracy.value = prettyMove(currentNode.value.san) + config.text
  }
  function displayBest() {
    if (['brilliant', 'best', 'great', 'book'].includes(moveData.value.move_accuracy)) return ""
    if (moveData.value.best_move === "") return ""
    return prettyMove(bestMoveSan.value) + " was the best"
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
  function sanBest() {
    if (!moveData.value?.best_move) return
    const baseFen = currentNode.value.parent ? currentNode.value.parent.fen : moveTree.fen
    bestChess.load(baseFen)
    const bestMove = bestChess.move(moveData.value.best_move, { sloppy: true })
    if (!bestMove) return
    bestMoveSan.value = bestMove.san
  }
  function uciSecondLine() {
    excellentSanLine.value = []
    if (!moveData.value?.excellent_line) return
    let secondLineNum = 0
    excellentChess.load(chess.fen())
    for (let i = 0; i < 30; i++) {
      const m = moveData.value.excellent_line[secondLineNum]
      if (!m) break
      const mm = excellentChess.move(m, { sloppy: true })
      if (!mm) break
      excellentSanLine.value.push(mm.san)
      secondLineNum++
    }
  }
  function uciThirdLine() {
    thirdSanLine.value = []
    if (!moveData.value?.third_line) return
    let thirdLineNum = 0
    thirdChess.load(chess.fen())
    for (let i = 0; i < 30; i++) {
      const m = moveData.value.third_line[thirdLineNum]
      if (!m) break
      const mm = thirdChess.move(m, { sloppy: true })
      if (!mm) break
      thirdSanLine.value.push(mm.san)
      thirdLineNum++
    }
  }
  function prettyMove(move) {
    const pieces = { 'K': '♚', 'Q': '♛', 'R': '♜', 'B': '♝', 'N': '♞' }
    return move ? move.replace(/[KQRBN]/g, p => pieces[p]) : ''
  }
  function formatCount(num) {
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B'
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
    if (num >= 10_000) return Math.round(num / 1000) + 'K'
    return num.toLocaleString()
  }
  function squareStyle(square) {
    if (!square) return {}
    const file = square.charCodeAt(0) - 97
    const rank = parseInt(square[1]) - 1
    const flipped = (rotate.value / 180) % 2 === 1
    const col = flipped ? 7 - file : file
    const row = flipped ? rank : 7 - rank
    return { position: 'absolute', left: `${(col + 1) * 12.5}%`, top: `${row * 12.5}%`, transform: 'translate(-70%, -35%)' }
  }

  async function playMove() {
    if (!moveData.value?.best_move) return
    const uci = moveData.value.best_move
    const from = uci.slice(0, 2), to = uci.slice(2, 4)
    const promotion = uci.length > 4 ? uci[4] : undefined
    undoMove()
    let sanMove
    try { sanMove = chess.move({ from, to, promotion: promotion ?? undefined }) } catch (e) { sanMove = null }
    if (!sanMove) return
    soundForLastMove(sanMove)
    const existing = currentNode.value.children.find(c => c.uci === uci)
    if (existing) { currentNode.value = existing }
    else {
      const newNode = {
        id: nodeIdCounter++, san: sanMove.san, uci, fen: chess.fen(),
        accuracy: null, analysisData: null, parent: currentNode.value, children: []
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
    if (isImporting.value) return
    switch (event.key) {
      case 'ArrowLeft': if (currentTime - lastPress < delay) return; lastPress = currentTime; undoAccuracy(); break
      case 'ArrowRight': if (currentTime - lastPress < delay) return; lastPress = currentTime; redoAccuracy(); break
      case 'Home': event.preventDefault(); goToStart(); break
      case 'End': event.preventDefault(); goToEnd(); break
    }
  }

  function applyUciMove(uci) {
    const from = uci.slice(0, 2)
    let to = uci.slice(2, 4)
    const promotion = uci.length > 4 ? uci[4] : undefined
    const castlingFix = { 'e1h1': 'g1', 'e1a1': 'c1', 'e8h8': 'g8', 'e8a8': 'c8' }
    if (castlingFix[uci]) to = castlingFix[uci]
    let sanMove
    try { sanMove = chess.move({ from, to, promotion: promotion ?? undefined }) }
    catch (e) { console.warn('Move execution failed for', uci, e); return false }
    if (!sanMove) return false
    const normalizedUci = `${from}${to}${promotion ?? ''}`
    const existing = currentNode.value.children.find(c => c.uci === normalizedUci)
    if (existing) { currentNode.value = existing }
    else {
      const newNode = {
        id: nodeIdCounter++, san: sanMove.san, uci: normalizedUci, fen: chess.fen(),
        accuracy: null, analysisData: null, parent: currentNode.value, children: []
      }
      nodeMap[newNode.id] = newNode
      currentNode.value.children.push(newNode)
      currentNode.value = newNode
      if (!isImporting.value) treeVersion.value++
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

  async function loadFen(fen) {
    chess.load(fen)
    moveTree.fen = fen
    currentNode.value = moveTree
    if (boardAPI.value) boardAPI.value.setPosition(fen)
  }

  async function loadImportedGame(uciList) {
    isImporting.value = true
    importCancelled = false
    importProgress.value = { current: 0, total: uciList.length }
    try {
      for (const uci of uciList) {
        if (importCancelled) break
        const result = applyUciMove(uci)
        if (!result) break
        await getAccuracy()
        importProgress.value.current++
        boardAPI.value.setPosition(chess.fen())
      }
      if (!importCancelled) {
        goToStart()
        treeVersion.value++
        await saveGameInsights()
        activeTab.value = 'report'
      }
    } finally {
      isImporting.value = false
      getAccuracy()
    }
  }
  async function tryLoadImportedGame() {
    if (boardReady && engineReady && route.query.moves) {
      const importedUciList = route.query.moves.split('-')
      await loadImportedGame(importedUciList)
    }
  }
  async function cancelImport() {
    importCancelled = true
    await cancelAnalysis()
    isImporting.value = false
    resetAccuracy()
    hasPlayerInfo.value = false
    router.replace({ path: '/', query: {} })
  }

  const classificationOrder = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder']
  const classificationMeta = {
    brilliant: { label: 'Brilliant', color: '#03aea7' },
    great: { label: 'Great', color: '#4c8cb5' },
    best: { label: 'Best', color: '#6ad13f' },
    excellent: { label: 'Excellent', color: '#90bc36' },
    good: { label: 'Good', color: '#8eae83' },
    book: { label: 'Book', color: '#ad8760' },
    inaccuracy: { label: 'Inaccuracy', color: '#f2bc43' },
    mistake: { label: 'Mistake', color: '#f38800' },
    blunder: { label: 'Blunder', color: '#FF0000' }
  }
  const accuracyWeights = {
    brilliant: 100, great: 100, best: 100, book: 100,
    excellent: 90, good: 80, inaccuracy: 20, mistake: 10, blunder: 0
  }

  const gameReportStats = computed(() => {
    treeVersion.value
    function emptyCounts() { return classificationOrder.reduce((acc, key) => ({ ...acc, [key]: 0 }), {}) }
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
    const finalize = (side) => ({ counts: side.counts, accuracy: side.moveCount > 0 ? (side.weightedSum / side.moveCount) : null })
    return { white: finalize(white), black: finalize(black) }
  })

  const estimatedRatings = computed(() => {
    const estimate = (accuracy) => {
      if (accuracy === null) return null
      if (accuracy >= 90) return Math.round(2000 + (accuracy - 90) * 50)
      if (accuracy >= 70) return Math.round(1600 + (accuracy - 70) * 20)
      return Math.round(900 + accuracy * 10)
    }
    return {
      white: estimate(gameReportStats.value.white.accuracy),
      black: estimate(gameReportStats.value.black.accuracy)
    }
  })

  const importProgressPercent = computed(() => {
    if (!importProgress.value.total) return 0
    return Math.round((importProgress.value.current / importProgress.value.total) * 100)
  })

  const currentUserId = ref(null)
  let pendingGameMeta = null

  onMounted(() => {
    onAuthStateChanged(auth, (user) => { if (user) currentUserId.value = user.uid })
  })

  watch(() => route.query, (newQuery) => {
    if (newQuery.white || newQuery.black) {
      pendingGameMeta = {
        white: newQuery.white || 'White',
        black: newQuery.black || 'Black',
        pgn: newQuery.pgn || null,
        myColor: newQuery.myColor || null
      }
    } else {
      pendingGameMeta = null
    }
  }, { immediate: true })

  function calculateMaterialBalance(fen) {
    const parts = fen.split(' ')
    const board = parts[0]
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9 }
    let whiteMat = 0, blackMat = 0
    for (const char of board) {
      if (values[char.toLowerCase()]) {
        if (char === char.toUpperCase()) whiteMat += values[char.toLowerCase()]
        else blackMat += values[char.toLowerCase()]
      }
    }
    return { whiteMat, blackMat }
  }

  function getGamePhases(uciList) {
    const c = new Chess()
    let openingEndPly = 12
    let endgameStartPly = Infinity
    for (let i = 0; i < uciList.length; i++) {
      c.move(uciList[i])
      const fen = c.fen()
      const { whiteMat, blackMat } = calculateMaterialBalance(fen)
      if ((whiteMat < 14 && blackMat < 14) || (whiteMat < 10 || blackMat < 10)) {
        if (i >= openingEndPly) { endgameStartPly = i + 1; break }
      }
    }
    return {
      opening: [0, Math.min(openingEndPly, uciList.length)],
      middlegame: [openingEndPly, Math.min(endgameStartPly, uciList.length)],
      endgame: [endgameStartPly, uciList.length]
    }
  }

  function bucketLabel(moveNum) {
    if (moveNum <= 10) return '1-10'
    if (moveNum <= 20) return '11-20'
    if (moveNum <= 30) return '21-30'
    if (moveNum <= 40) return '31-40'
    return '41+'
  }

  function resultForColor(color) {
    if (gameResult.value === '1-0') return color === 'white' ? 'win' : 'lose'
    if (gameResult.value === '0-1') return color === 'black' ? 'win' : 'lose'
    if (gameResult.value === '1/2-1/2') return 'draw'
    return 'unknown'
  }

  async function saveGameInsights() {
    if (!currentUserId.value || !pendingGameMeta) return

    const uciList = []
    let curr = moveTree.children[0]
    while (curr) { uciList.push(curr.uci); curr = curr.children[0] }
    if (uciList.length === 0) return

    const myColor = pendingGameMeta.myColor === 'black' ? 'black' : 'white'

    const weights = { brilliant: 100, great: 100, best: 100, book: 100, excellent: 90, good: 80, inaccuracy: 20, mistake: 10, blunder: 0 }
    const myCounts = { brilliant: 0, great: 0, best: 0, book: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
    let myWeightedSum = 0
    let myMoveCount = 0
    const moveBuckets = {}

    let node = moveTree.children[0]
    let ply = 1
    while (node) {
      const side = ply % 2 === 1 ? 'white' : 'black'
      if (side === myColor && node.accuracy && myCounts.hasOwnProperty(node.accuracy)) {
        const w = weights[node.accuracy] ?? 0
        myCounts[node.accuracy]++
        myWeightedSum += w
        myMoveCount++
        const label = bucketLabel(Math.ceil(ply / 2))
        if (!moveBuckets[label]) moveBuckets[label] = { sum: 0, count: 0 }
        moveBuckets[label].sum += w
        moveBuckets[label].count++
      }
      node = node.children[0]
      ply++
    }

    const overallAccuracy = myMoveCount > 0 ? (myWeightedSum / myMoveCount) : null

    const phases = getGamePhases(uciList)
    const phaseAccuracy = { opening: null, middlegame: null, endgame: null }
    const phaseCounts = { opening: 0, middlegame: 0, endgame: 0 }
    for (const [phase, [start, end]] of Object.entries(phases)) {
      let phaseSum = 0, phaseCount = 0
      let n = moveTree.children[0]
      let p = 1
      while (n) {
        const side = p % 2 === 1 ? 'white' : 'black'
        if (p > start && p <= end && side === myColor && n.accuracy) {
          phaseSum += weights[n.accuracy] ?? 0
          phaseCount++
        }
        n = n.children[0]
        p++
      }
      if (phaseCount > 0) phaseAccuracy[phase] = phaseSum / phaseCount
      phaseCounts[phase] = phaseCount
    }

    const blunderSquares = {}
    const goodSquares = {}
    let trackNode = moveTree.children[0]
    let trackPly = 1
    while (trackNode) {
      const side = trackPly % 2 === 1 ? 'white' : 'black'
      if (side === myColor) {
        const square = trackNode.uci.slice(2, 4)
        if (trackNode.accuracy === 'blunder' || trackNode.accuracy === 'mistake') {
          blunderSquares[square] = (blunderSquares[square] || 0) + 1
        } else if (['brilliant', 'great', 'best', 'excellent'].includes(trackNode.accuracy)) {
          goodSquares[square] = (goodSquares[square] || 0) + 1
        }
      }
      trackNode = trackNode.children[0]
      trackPly++
    }

    const pieceStats = { p: { count: 0, sum: 0 }, n: { count: 0, sum: 0 }, b: { count: 0, sum: 0 }, r: { count: 0, sum: 0 }, q: { count: 0, sum: 0 }, k: { count: 0, sum: 0 } }
    let pieceNode = moveTree.children[0]
    let piecePly = 1
    while (pieceNode) {
      const side = piecePly % 2 === 1 ? 'white' : 'black'
      if (side === myColor && pieceNode.accuracy && pieceNode.san) {
        let piece = 'p'
        const firstChar = pieceNode.san[0]
        if (['N', 'B', 'R', 'Q', 'K'].includes(firstChar)) piece = firstChar.toLowerCase()
        pieceStats[piece].count++
        pieceStats[piece].sum += weights[pieceNode.accuracy] ?? 0
      }
      pieceNode = pieceNode.children[0]
      piecePly++
    }

    const toCp = (ev) => {
      if (!ev) return null
      if (ev.type === 'mate') return Math.sign(ev.value) * 10000
      return ev.value
    }
    const fromMyPerspective = (cpv) => (myColor === 'white' ? cpv : -cpv)
    const myMat = (fen) => {
      const { whiteMat, blackMat } = calculateMaterialBalance(fen)
      return myColor === 'white' ? whiteMat : blackMat
    }

    let checks = 0, captures = 0, sacrifices = 0
    let inducedErrors = 0
    let cpLost = 0, cpWon = 0
    let bigSwingsFor = 0, bigSwingsAgainst = 0
    let defendSum = 0, defendCount = 0
    let attackSum = 0, attackCount = 0
    let myLastMoveWasStrong = false

    const STRONG = ['brilliant', 'great', 'best', 'excellent']
    const ERROR_WEIGHT = { inaccuracy: 1, mistake: 2, blunder: 3 }

    let prevNode = moveTree
    let tNode = moveTree.children[0]
    let tPly = 1
    while (tNode) {
      const side = tPly % 2 === 1 ? 'white' : 'black'
      const isMine = side === myColor
      const before = toCp(prevNode.analysisData?.eval)
      const after = toCp(tNode.analysisData?.eval)
      const delta = (before !== null && after !== null) ? fromMyPerspective(after) - fromMyPerspective(before) : null

      if (isMine) {
        if (tNode.san?.includes('+') || tNode.san?.includes('#')) checks++
        if (tNode.san?.includes('x')) captures++
        if (delta !== null) {
          if (delta < 0) cpLost += Math.min(-delta, 1000)
          if (delta <= -150) bigSwingsAgainst++
          const w = weights[tNode.accuracy]
          if (w !== undefined) {
            const stance = fromMyPerspective(before)
            if (stance <= -150) { defendSum += w; defendCount++ }
            else if (stance >= 150) { attackSum += w; attackCount++ }
          }
        }
        const reply = tNode.children[0] ?? null
        const replyEval = reply ? toCp(reply.analysisData?.eval) : null
        if (reply && before !== null && replyEval !== null) {
          const materialLost = myMat(prevNode.fen) - myMat(reply.fen)
          const windowDelta = fromMyPerspective(replyEval) - fromMyPerspective(before)
          if (materialLost >= 2 && windowDelta >= -100) sacrifices++
        }
        myLastMoveWasStrong = STRONG.includes(tNode.accuracy)
      } else {
        if (delta !== null) {
          if (delta > 0) cpWon += Math.min(delta, 1000)
          if (delta >= 150) bigSwingsFor++
        }
        if (myLastMoveWasStrong && ERROR_WEIGHT[tNode.accuracy]) inducedErrors += ERROR_WEIGHT[tNode.accuracy]
        myLastMoveWasStrong = false
      }
      prevNode = tNode
      tNode = tNode.children[0] ?? null
      tPly++
    }

    let result = null
    const resultMatch = (pendingGameMeta.pgn || '').match(/\[Result\s+"([^"]+)"\]/)
    if (resultMatch) {
      const r = resultMatch[1]
      if (r === '1-0') result = myColor === 'white' ? 'win' : 'loss'
      else if (r === '0-1') result = myColor === 'black' ? 'win' : 'loss'
      else if (r === '1/2-1/2') result = 'draw'
    }

    const playstyle = {
      v: 2,
      myMoves: myMoveCount,
      totalPlies: uciList.length,
      checks, captures,
      forcingMoves: checks + captures,
      sacrifices, inducedErrors,
      brilliantPlus: myCounts.brilliant + myCounts.great,
      bookMoves: myCounts.book,
      errors: { inaccuracy: myCounts.inaccuracy, mistake: myCounts.mistake, blunder: myCounts.blunder },
      cpLost, cpWon, bigSwingsFor, bigSwingsAgainst,
      defendSum, defendCount, attackSum, attackCount,
      phaseCounts,
      reachedEndgame: phases.endgame[0] < uciList.length ? 1 : 0,
      result
    }

    const openingName = await fetchOpeningNameForSave(uciList)

    const pgn = pendingGameMeta.pgn || chess.pgn()
    function generatePgnHash(p) {
      let hash = 0
      for (let i = 0; i < p.length; i++) { hash = (hash << 5) - hash + p.charCodeAt(i); hash &= hash }
      return String(hash)
    }
    const pgnHash = generatePgnHash(pgn)

    const extractedPuzzles = []
    let pNode = moveTree.children[0]
    let pPly = 1
    while (pNode) {
      const side = pPly % 2 === 1 ? 'white' : 'black'
      if (side === myColor && (pNode.accuracy === 'blunder' || pNode.accuracy === 'mistake')) {
        if (pNode.parent && pNode.analysisData?.best_move) {
          const beforeEval = pNode.parent.analysisData?.eval
          const afterEval = pNode.analysisData.eval
          if (beforeEval && afterEval) {
            const beforeCp = beforeEval.type === 'mate' ? Math.sign(beforeEval.value) * 10000 : beforeEval.value
            const afterCp = afterEval.type === 'mate' ? Math.sign(afterEval.value) * 10000 : afterEval.value
            let isPuzzleWorthy = false
            if (side === 'white') {
              if (beforeCp >= -300 && afterCp <= 300 && (beforeCp - afterCp >= 200)) isPuzzleWorthy = true
            } else {
              if (beforeCp <= 300 && afterCp >= -300 && (afterCp - beforeCp >= 200)) isPuzzleWorthy = true
            }
            if (isPuzzleWorthy) {
              extractedPuzzles.push({
                fen: pNode.parent.fen,
                bestMove: pNode.analysisData.best_move,
                playedMove: pNode.uci,
                playedMoveAccuracy: pNode.accuracy,
                turn: side,
                eval: { type: afterEval.type, value: afterEval.value },
                swing: Math.abs(beforeCp - afterCp),
                continuation: Array.isArray(pNode.analysisData.best_line) ? pNode.analysisData.best_line.slice(0, 5) : [],
                mateIn: beforeEval.type === 'mate' ? Math.abs(beforeEval.value) : null
              })
            }
          }
        }
      }
      pNode = pNode.children[0]
      pPly++
    }

    const whitePlayer = { username: whiteName.value || 'White', rating: whiteRating.value || 0, result: resultForColor('white') }
    const blackPlayer = { username: blackName.value || 'Black', rating: blackRating.value || 0, result: resultForColor('black') }

    const insightsPayload = {
      myColor,
      overallAccuracy,
      phaseAccuracy,
      moveCounts: myCounts,
      totalMoves: myMoveCount,
      opening: openingName,
      blunderSquares,
      goodSquares,
      pieceStats,
      playstyle,
      moveBuckets
    }

    const gamesRef = collection(db, `users/${currentUserId.value}/games`)
    const dupQ = query(gamesRef, where('pgnHash', '==', pgnHash))
    const dupSnap = await getDocs(dupQ)

    if (!dupSnap.empty) {
      const gameDoc = dupSnap.docs[0]
      const gameDocData = gameDoc.data()
      const existingPuzzles = gameDocData.puzzles || []
      const mergedPuzzles = extractedPuzzles.map(newP => {
        const oldP = existingPuzzles.find(p => p.fen === newP.fen && p.bestMove === newP.bestMove)
        return oldP ? {
          ...newP,
          solved: oldP.solved || false,
          solvedAt: oldP.solvedAt ?? null,
          reps: oldP.reps ?? 0,
          dueAt: oldP.dueAt ?? null
        } : newP
      })
      await updateDoc(doc(db, `users/${currentUserId.value}/games`, gameDoc.id), {
        insights: insightsPayload,
        puzzles: mergedPuzzles,
        white: whitePlayer,
        black: blackPlayer
      })
    } else {
      await addDoc(gamesRef, {
        pgn,
        pgnHash,
        white: whitePlayer,
        black: blackPlayer,
        time_class: 'unknown',
        createdAt: serverTimestamp(),
        insights: insightsPayload,
        puzzles: extractedPuzzles
      })
    }
  }

  async function fetchOpeningNameForSave(uciList) {
    const OPENING_LOOKUP_PLIES = 12
    const playList = uciList.slice(0, OPENING_LOOKUP_PLIES)
    const bookList = playList.join(",")
    const url = bookList
      ? `../../api/explorer?db=masters&play=${encodeURIComponent(bookList)}`
      : `../../api/explorer?db=masters`
    try {
      const response = await fetch(url)
      if (!response.ok) return "Unknown Opening"
      const data = await response.json()
      return data.opening?.name || "Unknown Opening"
    } catch (e) {
      console.warn("Opening lookup for insights failed:", e)
      return "Unknown Opening"
    }
  }
</script>

<template>
  <SettingsPanel
    v-model:isOpen="isSettingsOpen"
    v-model:targetDepth="targetDepth"
    v-model:soundOn="soundOn"
    v-model:showBestArrow="showBestArrow"
    v-model:boardTheme="currentTheme"
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
        <div class="loading-tips">
          <p class="loading-tip">Review stuck? A quick page refresh usually fixes it.</p>
          <p class="loading-tip">Feels slow? Try lowering the engine depth in Settings.</p>
        </div>
        <button class="cancel-import-btn" @click="cancelImport">Cancel review</button>
      </div>
    </div>
  </Transition>
  <div class="grid-layout">
    <Title class="title-slot" />
    <div class="board-area">
      <div class="board-wrapper" ref="boardRef" :style="{ '--last-move-highlight': lastMoveHighlightColor }">
        <div class="player-bar" v-if="hasPlayerInfo">
          <span class="player-color-dot" :class="topPlayer.side"></span>
          <span class="player-name">{{ topPlayer.name }}</span>
          <span v-if="topPlayer.isWinner" class="winner-crown">👑</span>
          <span class="player-rating" v-if="topPlayer.rating">{{ topPlayer.rating }}</span>
        </div>
        <div class="board-row">
          <div class="board-col">
            <TheChessboard
              class="game-board"
              @move="handleBothMoves"
              @board-created="onBoardCreated"
              :board-config="{ coordinates: true, animation: { enabled: false } }"
            />
            <img v-if="lastMoveSquare && lastMoveAccuracy" :src="accuracySymbol(lastMoveAccuracy)" class="board-acc-icon" :style="squareStyle(lastMoveSquare)" />
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
          <span v-if="bottomPlayer.isWinner" class="winner-crown">👑</span>
          <span class="player-rating" v-if="bottomPlayer.rating">{{ bottomPlayer.rating }}</span>
        </div>
        <div class="boardtools">
          <button class="toolbar-icon-btn settings-toggle" @click="isSettingsOpen = true" title="Settings">⚙️</button>
          <div class="boardtools-nav">
            <button class="jumpstart" @click="goToStart" :disabled="isImporting || currentNode.parent === null" title="Jump to start">&lt;&lt;</button>
            <button class="undo" @click="undoAccuracy" title="previous" :disabled="isImporting || currentNode.parent === null">&lt;-</button>
            <button class="reverse" @click="flipBoard" title="flip board">↳↰</button>
            <button class="redo" title="next" @click="redoAccuracy" :disabled="isImporting || currentNode.children.length === 0">-&gt;</button>
            <button class="jumpend" @click="goToEnd" :disabled="isImporting || currentNode.children.length === 0" title="Jump to end">&gt;&gt;</button>
          </div>
          <div class="share-menu-wrap">
            <button class="toolbar-icon-btn" @click="toggleShareMenu" title="Copy game">📋</button>
            <div v-if="shareMenuOpen" class="share-menu">
              <button @click="copyPGN(); shareMenuOpen = false">Copy PGN</button>
              <button @click="copyFEN(); shareMenuOpen = false">Copy FEN</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="analysis-container">
      <div class="analyze">
        <div class="analyzis-header">
          <h2 class="analyzis">Analysis <span v-if="isAnalyzing" class="thinking-dot" title="Engine is thinking"></span></h2>
        </div>
        <div v-if="moveData" class="move-data">
          <p class="depthnum">Depth {{ currentDepth }}</p>
          <div class="line pretty-scroll" :class="{ analyzing: isAnalyzing }">
            <span class="evalnum2">{{ formatEval(moveData?.eval) }}</span>
            <span v-for="(move, idx) in sanLine" :key="'best-' + idx" class="line-move" @click="playLineMoves(moveData.best_line, idx + 1)">{{ prettyMove(move) }}&nbsp;</span>
          </div>
          <div class="secondline pretty-scroll" v-if="excellentSanLine.length">
            <span class="evalnum3">{{ moveData?.excellent_eval ? formatEval(moveData.excellent_eval) : "" }}</span>
            <span v-for="(move, idx) in excellentSanLine" :key="'exc-' + idx" class="line-move" @click="playLineMoves(moveData.excellent_line, idx + 1)">{{ prettyMove(move) }}&nbsp;</span>
          </div>
          <div class="secondline pretty-scroll" v-if="thirdSanLine.length">
            <span class="evalnum3">{{ moveData?.third_eval ? formatEval(moveData.third_eval) : "" }}</span>
            <span v-for="(move, idx) in thirdSanLine" :key="'third-' + idx" class="line-move" @click="playLineMoves(moveData.third_line, idx + 1)">{{ prettyMove(move) }}&nbsp;</span>
          </div>
          <p :style="{color: color}" class="accuracydescribtion">{{ isAccuracy }}</p>
          <p class="bestmove" v-if="movesListUCI.length > 0" @click="playMove">{{ displayBest() }}</p>
        </div>
      </div>
      <div class="moves">
        <div class="tabs-toggle">
          <button :class="{ active: activeTab === 'moves' }" @click="activeTab = 'moves'">Moves</button>
          <button :class="{ active: activeTab === 'report' }" @click="activeTab = 'report'">Report</button>
          <button :class="{ active: activeTab === 'explorer' }" @click="activeTab = 'explorer'">Explorer</button>
        </div>
        <div class="moveslist" v-if="activeTab === 'moves'" ref="movesListRef">
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
        <div class="report" v-else-if="activeTab === 'report'">
          <div class="report-columns">
            <div class="report-col">
              <div class="report-side-header"><span class="side-swatch white-swatch"></span><span>White</span></div>
              <div class="accuracy-score" v-if="gameReportStats.white.accuracy !== null">{{ gameReportStats.white.accuracy.toFixed(1) }}<span class="accuracy-percent">%</span></div>
              <div class="accuracy-score empty" v-else>—</div>
              <div class="est-rating" v-if="estimatedRatings.white !== null"><span class="est-rating-label">Est. Rating</span><span class="est-rating-value">{{ estimatedRatings.white }}</span></div>
              <div class="est-rating empty" v-else><span class="est-rating-label">Est. Rating</span><span class="est-rating-value">—</span></div>
              <div v-for="key in classificationOrder" :key="'w-' + key" class="report-row" :class="{ dim: gameReportStats.white.counts[key] === 0 }">
                <img :src="accuracySymbol(key)" class="report-row-icon" />
                <span class="report-row-label" :style="{ color: classificationMeta[key].color }">{{ classificationMeta[key].label }}</span>
                <span class="report-row-count">{{ gameReportStats.white.counts[key] }}</span>
              </div>
            </div>
            <div class="report-col">
              <div class="report-side-header"><span class="side-swatch black-swatch"></span><span>Black</span></div>
              <div class="accuracy-score" v-if="gameReportStats.black.accuracy !== null">{{ gameReportStats.black.accuracy.toFixed(1) }}<span class="accuracy-percent">%</span></div>
              <div class="accuracy-score empty" v-else>—</div>
              <div class="est-rating" v-if="estimatedRatings.black !== null"><span class="est-rating-label">Est. Rating</span><span class="est-rating-value">{{ estimatedRatings.black }}</span></div>
              <div class="est-rating empty" v-else><span class="est-rating-label">Est. Rating</span><span class="est-rating-value">—</span></div>
              <div v-for="key in classificationOrder" :key="'b-' + key" class="report-row" :class="{ dim: gameReportStats.black.counts[key] === 0 }">
                <img :src="accuracySymbol(key)" class="report-row-icon" />
                <span class="report-row-label" :style="{ color: classificationMeta[key].color }">{{ classificationMeta[key].label }}</span>
                <span class="report-row-count">{{ gameReportStats.black.counts[key] }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="explorer" v-else-if="activeTab === 'explorer'">
          <div class="explorer-db-toggle">
            <button :class="{ active: explorerDb === 'masters' }" @click="explorerDb = 'masters'">Masters</button>
            <button :class="{ active: explorerDb === 'lichess' }" @click="explorerDb = 'lichess'">Players</button>
          </div>
          <div v-if="explorerLoading" class="explorer-status"><div class="mini-spinner"></div>Loading {{ explorerDb === 'masters' ? 'master' : 'player' }} games…</div>
          <div v-else-if="explorerError" class="explorer-status error">{{ explorerError }}</div>
          <template v-else>
            <div class="explorer-header">
              <span class="explorer-eco" v-if="openingEco">{{ openingEco }}</span>
              <span class="explorer-name">{{ opening }}</span>
            </div>
            <div class="explorer-table" v-if="explorerMoves.length">
              <div class="explorer-row explorer-row-head"><span class="col-move">Move</span><span class="col-games">Games</span><span class="col-split">W / D / B</span></div>
              <div v-for="m in explorerMoves" :key="m.uci" class="explorer-row" @click="playExplorerMove(m.uci)">
                <span class="col-move">{{ prettyMove(m.san) }}</span>
                <span class="col-games"><span class="games-percent">{{ m.percent }}%</span><span class="games-count">{{ formatCount(m.total) }}</span></span>
                <span class="col-split">
                  <div class="split-bar">
                    <div class="split-white" :style="{ width: m.white + '%' }"><span v-if="m.white >= 15" class="split-pct">{{ m.white }}%</span></div>
                    <div class="split-draw" :style="{ width: m.draws + '%' }"><span v-if="m.draws >= 15" class="split-pct">{{ m.draws }}%</span></div>
                    <div class="split-black" :style="{ width: m.black + '%' }"><span v-if="m.black >= 15" class="split-pct">{{ m.black }}%</span></div>
                  </div>
                </span>
              </div>
              <div class="explorer-row explorer-row-total" v-if="explorerStats">
                <span class="col-move">Σ</span>
                <span class="col-games"><span class="games-percent">100%</span><span class="games-count">{{ formatCount(explorerStats.total) }}</span></span>
                <span class="col-split">
                  <div class="split-bar">
                    <div class="split-white" :style="{ width: explorerStats.white + '%' }"><span v-if="explorerStats.white >= 15" class="split-pct">{{ explorerStats.white }}%</span></div>
                    <div class="split-draw" :style="{ width: explorerStats.draws + '%' }"><span v-if="explorerStats.draws >= 15" class="split-pct">{{ explorerStats.draws }}%</span></div>
                    <div class="split-black" :style="{ width: explorerStats.black + '%' }"><span v-if="explorerStats.black >= 15" class="split-pct">{{ explorerStats.black }}%</span></div>
                  </div>
                </span>
              </div>
            </div>
            <div class="explorer-status" v-else>No games found for this position</div>
          </template>
        </div>
      </div>
    </div>
  </div>
  <Teleport to="body">
    <div v-if="contextMenu.visible" class="context-menu" :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }" @click.stop>
      <button class="context-menu-item delete" @click="handleDeleteFromMenu">Delete move</button>
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

  .title-slot {
    grid-area: title;
    min-width: 0;
  }

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
    display: flex;
    flex-direction: column;
  }

  .game-board {
    width: 100% !important;
    height: auto !important;
    aspect-ratio: 1 / 1 !important;
    display: block;
  }

  :deep(.cg-wrap) {
    overflow: hidden;
    width: 100% !important;
    height: 100% !important;
    box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4);
    border-radius: 8px;
  }

  :deep(cg-board) {
    background: conic-gradient(
      var(--board-dark) 90deg,
      var(--board-light) 90deg 180deg,
      var(--board-dark) 180deg 270deg,
      var(--board-light) 270deg
    ) !important;
    background-size: 25% 25% !important;
  }

  /* Tint chessground's own last-move squares to match the accuracy badge color.
     --last-move-highlight is set inline on .board-wrapper based on the current move's classification. */
  :deep(cg-board square.last-move) {
    background-color: var(--last-move-highlight, rgba(155, 199, 0, 0.41)) !important;
  }

  .board-row {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
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
    box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.5);
  }

  .player-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.7rem;
    margin-bottom: 0.2rem;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.22);
    color: #f4f0e3;
    font-family: 'Inter', sans-serif;
    font-size: clamp(0.82rem, 1.8vw, 0.95rem);
    width: 100%;
    box-sizing: border-box;
  }

  .player-bar.bottom {
    margin-bottom: 0;
    margin-top: 0.2rem;
  }

  .player-color-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
  }

  .player-color-dot.white {
    background: #f4f0e3;
  }

  .player-color-dot.black {
    background: #1a1a1a;
  }

  .player-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .winner-crown {
    font-size: 1.1rem;
    filter: drop-shadow(0 0 4px gold);
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

  .moves {
    margin-top: 10px;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
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
    overflow: auto;
    min-height: 200px;
    max-height: 400px;
    scrollbar-width: thin;
    scrollbar-color: rgba(194, 197, 170, 0.4) rgba(0, 0, 0, 0.2);
  }

  @media (min-width: 1200px) {
    .moves {
      max-width: 20rem;
    }
  }

  .moveslist {
    margin: 0 auto;
    padding: 12px;
    width: 100%;
    box-sizing: border-box;
    background: linear-gradient(135deg, var(--list-1), var(--list-2));
    border-radius: 14px;
    font-size: clamp(0.9rem, 2vw, 1rem);
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    scroll-behavior: smooth;
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

  .move-row.variant {
    border-left: 2px solid rgba(232, 232, 208, 0.16);
  }

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

  .move-cell.variant {
    color: #dbe4ff;
    background: rgba(255, 255, 255, 0.06);
  }

  .move-cell.empty {
    pointer-events: none;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }

  .move-num {
    color: rgba(232, 232, 208, 0.72);
    font-size: 0.78em;
    font-weight: 700;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.16);
  }

  .move-san-text {
    font-weight: 600;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .acc-badge {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    margin-left: 2px;
  }

  .analysis-container {
    grid-area: analysis;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }

  .analyze {
    border-radius: 15px;
    width: 100%;
    max-width: 500px;
    min-height: 200px;
    padding-bottom: 1rem;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    box-sizing: border-box;
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin: auto;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.4) rgba(0, 0, 0, 0.1);
  }

  @media (min-width: 1200px) {
    .analyze {
      max-width: 20rem;
    }
  }

  .analyzis-header {
    display: flex;
    justify-content: center;
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

  .thinking-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #6ad13f;
    box-shadow: 0 0 8px rgba(106, 209, 63, 0.9);
    animation: thinkingPulse 1s ease-in-out infinite;
  }

  @keyframes thinkingPulse {
    0%, 100% { opacity: 0.35; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1.15); }
  }

  .analysis-loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 10, 6, 0.25);
    backdrop-filter: blur(4px) saturate(105%);
  }

  .loading-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
    padding: 2rem 2.5rem;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 18px;
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.5);
    max-width: min(90vw, 22rem);
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
    border-top-color: var(--text-highlight);
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

  @keyframes spinRing {
    to { transform: rotate(360deg); }
  }

  .loading-title {
    font-family: serif;
    color: #f5f5dc;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    font-size: 1.05rem;
    margin: 0;
    text-align: center;
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
    background: linear-gradient(90deg, var(--text-highlight), #a8d97a);
    transition: width 0.3s ease;
  }

  .loading-tips {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.3rem;
    padding-top: 0.8rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    width: 100%;
  }

  .loading-tip {
    font-size: 0.78rem;
    color: rgba(244, 240, 227, 0.65);
    text-align: center;
    margin: 0;
    line-height: 1.4;
  }

  .cancel-import-btn {
    margin-top: 0.5rem;
    padding: 0.55rem 1.3rem;
    border-radius: 8px;
    border: 1px solid rgba(255, 107, 107, 0.35);
    background: rgba(255, 60, 60, 0.12);
    color: #ffb0a8;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .loading-fade-enter-active,
  .loading-fade-leave-active {
    transition: opacity 0.35s ease;
  }

  .loading-fade-enter-from,
  .loading-fade-leave-to {
    opacity: 0;
  }

  .tabs-toggle {
    display: flex;
    gap: 4px;
    background: rgba(0, 0, 0, 0.25);
    padding: 4px;
    border-radius: 10px;
    margin: 12px 0.5rem 0;
  }

  .tabs-toggle button {
    flex: 1;
    background: transparent;
    border: none;
    color: rgba(245, 245, 220, 0.6);
    padding: 0.55rem 0.4rem;
    border-radius: 7px;
    cursor: pointer;
    font-weight: 700;
    font-family: serif;
    font-size: clamp(0.7rem, 2vw, 0.95rem);
    text-transform: uppercase;
    letter-spacing: 1px;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: all 0.2s ease;
  }

  .tabs-toggle button:hover:not(.active) {
    color: rgba(245, 245, 220, 0.85);
    background: rgba(255, 255, 255, 0.04);
  }

  .tabs-toggle button.active {
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    color: #f4f0e3;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .boardtools {
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;
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
    flex-wrap: nowrap;
  }

  .boardtools-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }

  /* Shared icon-button style for the toolbar's Settings / Copy game
     buttons - visible on both desktop and mobile now. */
  .toolbar-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--btn-idle);
    width: clamp(30px, 6vw, 36px);
    height: clamp(30px, 6vw, 36px);
    border: none;
    border-radius: 12px;
    font-size: clamp(14px, 3vw, 16px);
    color: #e8e8d0;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.2s ease;
  }

  .toolbar-icon-btn:hover {
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  .share-menu-wrap {
    position: relative;
  }

  .share-menu {
    position: absolute;
    bottom: 120%;
    left: 0;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    min-width: 7.5rem;
    overflow: hidden;
    z-index: 50;
  }

  .share-menu button {
    background: transparent;
    border: none;
    color: #f4f0e3;
    padding: 0.55rem 0.8rem;
    text-align: left;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }

  .share-menu button:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .share-menu button + button {
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .reverse,
  .undo,
  .redo,
  .jumpstart,
  .jumpend {
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

  .reverse:disabled,
  .undo:disabled,
  .redo:disabled,
  .jumpstart:disabled,
  .jumpend:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .reverse:hover:not(:disabled),
  .undo:hover:not(:disabled),
  .redo:hover:not(:disabled),
  .jumpstart:hover:not(:disabled),
  .jumpend:hover:not(:disabled) {
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  .blackeval,
  .whiteeval {
    width: 100%;
    transition: all 0.5s ease;
    position: relative;
  }

  .blackeval {
    background-color: #38412e;
  }

  .whiteeval {
    background-color: #626949;
  }

  .evalnum {
    font-family: "JetBrains Mono", monospace;
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: clamp(0.62rem, 1vw, 0.85rem);
    font-weight: 600;
    color: #fff8ef;
    text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.6);
    background: rgba(0, 0, 0, 0.3);
    padding: 0.25rem 0.4rem;
    border-radius: 6px;
    backdrop-filter: blur(4px);
    z-index: 10;
    white-space: nowrap;
    width: max-content;
  }

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

  .move-data {
    padding: 0 1rem;
  }

  .depthnum {
    text-align: center;
    color: rgba(245, 245, 220, 0.7);
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    margin: 0.3rem 0 0.5rem;
  }

  .line,
  .secondline {
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
  }

  /* Custom Scrollbar Styles for Analysis Lines */
  .pretty-scroll {
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.2) rgba(0, 0, 0, 0.15);
  }

  .pretty-scroll::-webkit-scrollbar {
    height: 5px;
  }

  .pretty-scroll::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.15);
    border-radius: 10px;
  }

  .pretty-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 10px;
  }

  .pretty-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.35);
  }

  .evalnum2,
  .evalnum3 {
    font-size: clamp(1rem, 2vw, 1.3rem);
    color: #171717;
    background-color: #606847;
    border-radius: 10px;
    flex-shrink: 0;
    min-width: 4.4rem;
    width: auto;
    padding: 0 0.5rem;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .board-acc-icon {
    position: absolute;
    width: 4.5%;
    height: 4.5%;
    border-radius: 50%;
    pointer-events: none;
  }

  .line-move {
    cursor: pointer;
    padding: 0 2px;
    border-radius: 4px;
  }

  .line-move:hover {
    background: rgba(103, 122, 228, 0.3);
  }

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

  .toast-fade-enter-active,
  .toast-fade-leave-active {
    transition: opacity 0.25s ease, transform 0.25s ease;
  }

  .toast-fade-enter-from,
  .toast-fade-leave-to {
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

  .context-menu-item.delete {
    color: #ff6b6b;
  }

  .context-menu-item.delete:hover {
    background: rgba(255, 60, 60, 0.2);
  }

  .report {
    padding: 1rem;
    max-height: 400px;
    box-sizing: border-box;
  }

  .report-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }

  .report-col {
    min-width: 0;
    background: linear-gradient(135deg, var(--list-1), var(--list-2));
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
  }

  .side-swatch {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
    display: inline-block;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
    flex-shrink: 0;
  }

  .white-swatch {
    background: #f4f0e3;
  }

  .black-swatch {
    background: #1a1a1a;
  }

  .accuracy-score {
    font-family: "JetBrains Mono", monospace;
    font-size: clamp(1.2rem, 5vw, 1.7rem);
    font-weight: 700;
    color: #a8d97a;
    text-align: center;
    margin: 0.1rem 0 0.1rem;
  }

  .accuracy-score.empty {
    color: rgba(245, 245, 220, 0.4);
    font-size: 1.2rem;
  }

  .accuracy-percent {
    font-size: 0.6em;
    opacity: 0.75;
  }

  .est-rating {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-bottom: 0.8rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .est-rating-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: rgba(245, 245, 220, 0.5);
    font-weight: 600;
    margin-bottom: 0.2rem;
  }

  .est-rating-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.1rem;
    font-weight: 700;
    color: #a8d97a;
  }

  .est-rating.empty .est-rating-value {
    color: rgba(245, 245, 220, 0.4);
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

  .explorer {
    padding: 0.4rem 0.5rem 0.6rem;
    box-sizing: border-box;
    max-height: 400px;
  }

  .explorer-status {
    text-align: center;
    color: rgba(245, 245, 220, 0.7);
    font-size: 0.9rem;
    padding: 2rem 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .explorer-status.error {
    color: #ffb0a8;
  }

  .mini-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--text-highlight);
    border-radius: 50%;
    animation: spinRing 1s linear infinite;
  }

  .explorer-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.25rem 0.3rem 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    margin-bottom: 0.4rem;
    flex-wrap: wrap;
  }

  .explorer-eco {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    font-size: 0.85rem;
    color: var(--text-highlight);
    background: rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 0.1rem 0.4rem;
    flex-shrink: 0;
  }

  .explorer-name {
    font-family: serif;
    font-weight: 700;
    color: #f5f5dc;
    font-size: clamp(0.95rem, 2.2vw, 1.15rem);
    white-space: normal;
    word-break: break-word;
  }

  .explorer-table {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .explorer-row {
    display: grid;
    grid-template-columns: 2.3rem 1fr 1.6fr;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.5rem;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.15);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .explorer-row:not(.explorer-row-head):not(.explorer-row-total):hover {
    background: rgba(103, 122, 228, 0.25);
    transform: translateX(3px);
  }

  .explorer-row-head {
    background: transparent;
    cursor: default;
    color: rgba(245, 245, 220, 0.55);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    padding-bottom: 0.1rem;
  }

  .explorer-row-total {
    cursor: default;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin-top: 0.4rem;
    font-weight: 700;
  }

  .col-move {
    font-weight: 700;
    color: var(--text-highlight);
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .col-games {
    display: flex;
    flex-direction: column;
    line-height: 1.1;
    align-items: flex-start;
  }

  .games-percent {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    font-size: 0.8rem;
    color: #f4f0e3;
  }

  .games-count {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.62rem;
    color: rgba(244, 240, 227, 0.45);
  }

  .col-split {
    min-width: 0;
  }

  .split-bar {
    display: flex;
    width: 100%;
    height: 1.1rem;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
  }

  .split-white,
  .split-draw,
  .split-black {
    height: 100%;
    transition: width 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.62rem;
    font-weight: 700;
    overflow: hidden;
    white-space: nowrap;
  }

  .split-white {
    background: #e8e4d8;
    color: #333;
  }

  .split-draw {
    background: #8a8a86;
    color: #f4f0e3;
  }

  .split-black {
    background: #2b2b2b;
    color: #f4f0e3;
  }

  .explorer-db-toggle {
    display: flex;
    gap: 4px;
    background: rgba(0, 0, 0, 0.25);
    padding: 4px;
    border-radius: 10px;
    margin: 0 0.5rem 0.8rem;
  }

  .explorer-db-toggle button {
    flex: 1;
    background: transparent;
    border: none;
    color: rgba(245, 245, 220, 0.6);
    padding: 0.45rem;
    border-radius: 7px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    transition: all 0.2s ease;
  }

  .explorer-db-toggle button.active {
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    color: #f4f0e3;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  @media (max-width: 767px) {
    .acc-badge {
      width: 24px;
      height: 24px;
    }
    .board-acc-icon {
      width: 5.2%;
      height: 5.2%;
    }
    .report-row-icon {
      width: 18px;
      height: 18px;
    }

    /* ---- Flatten the layout wrappers so their children become direct
       flex items of .grid-layout and can be freely reordered with
       `order` - lines above the board, board, then tabs, then the tool
       bar, matching a Lichess-style mobile layout. Desktop's grid-area
       layout above is completely untouched. ---- */
    .grid-layout {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
      padding: 0.4rem;
      gap: 0.4rem;
    }
    .board-area,
    .board-wrapper,
    .analysis-container {
      display: contents;
    }

    .title-slot { order: 0; }
    .analyze    { order: 1; } /* engine lines, small, above the board */
    .player-bar { order: 2; }
    .board-row  { order: 2; }
    .moves      { order: 3; } /* moves / report / explorer */
    .boardtools { order: 4; } /* nav + relocated settings/share, at the bottom */

    .board-wrapper {
      max-width: 100%;
    }

    .evalbar {
      width: clamp(28px, 6vw, 44px);
    }

    .player-bar {
      padding: 0.22rem 0.55rem;
      margin: 0;
      font-size: 0.78rem;
    }

    /* ---- Engine lines: strip the panel chrome, drop the header, depth
       text, move description and best-move hint (Copy PGN/FEN and
       Settings live in the sticky toolbar below) - just the line rows. ---- */
    .analyze {
      background: none;
      box-shadow: none;
      border: none;
      padding: 0;
      margin: 0;
      max-width: none;
      min-height: 0;
    }
    .move-data {
      padding: 0;
    }
    .analyzis-header,
    .depthnum,
    .accuracydescribtion,
    .bestmove {
      display: none;
    }
    .line,
    .secondline {
      font-size: 0.74rem;
      padding: 0.32rem 0.45rem;
      margin: 3px 0;
      gap: 0.35rem;
    }
    .evalnum2,
    .evalnum3 {
      font-size: 0.78rem;
      min-width: 2.8rem;
      padding: 0 0.4rem;
    }
    .line.analyzing {
      animation: linePulse 1.2s ease-in-out infinite;
    }
    @keyframes linePulse {
      0%, 100% { box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.4); }
      50% { box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(106, 209, 63, 0.55); }
    }

    /* ---- Moves / Report / Explorer now get the room the analysis
       panel used to take up. ---- */
    .moves {
      flex: 1 1 auto;
      min-height: 280px;
      height: auto;
      max-width: none;
      margin: 0;
    }

    .tabs-toggle {
      margin: 8px 0.4rem 0;
    }

    .moveslist {
      padding: 8px;
      gap: 0.4rem;
    }

    .move-cell {
      min-height: 2.1rem;
      padding: 0.4rem 0.55rem;
    }

    .report {
      padding: 0.6rem;
    }

    .report-col {
      padding: 0.55rem 0.4rem;
    }

    .accuracy-score {
      margin: 0.2rem 0 0.4rem;
    }

    .est-rating {
      margin-bottom: 0.5rem;
      padding-bottom: 0.4rem;
    }

    .report-row {
      padding: 0.2rem 0.25rem;
    }

    .explorer {
      padding: 0.4rem 0.5rem 0.6rem;
    }

    .explorer-header {
      padding: 0.25rem 0.3rem 0.5rem;
      margin-bottom: 0.4rem;
    }

    .explorer-table {
      gap: 0.25rem;
    }

    .explorer-row {
      grid-template-columns: 2.3rem 1fr 1.6fr;
      gap: 0.4rem;
      padding: 0.35rem 0.5rem;
      border-radius: 8px;
    }

    .explorer-row-head {
      font-size: 0.62rem;
      padding-bottom: 0.1rem;
    }

    .col-move {
      font-size: 0.88rem;
    }

    .games-percent {
      font-size: 0.8rem;
    }

    .games-count {
      font-size: 0.62rem;
    }

    .split-bar {
      height: 1.1rem;
      border-radius: 6px;
    }

    .explorer-db-toggle {
      margin: 0 0.4rem 0.5rem;
    }

    .explorer-db-toggle button {
      padding: 0.32rem;
      font-size: 0.72rem;
    }

    /* ---- Tool bar: sticks to the bottom of the viewport as a fallback
       for short devices that still need to scroll (Lichess-style bottom
       nav). Buttons are spaced using justify-content: space-between 
       so the side items touch the edges and the nav stays in the middle. ---- */
    .boardtools {
      position: sticky;
      bottom: 0;
      z-index: 40;
      min-height: 2.6rem;
      padding: 0.3rem 0.5rem calc(0.3rem + env(safe-area-inset-bottom, 0px));
      margin-top: 0;
      gap: 0.4rem;
      justify-content: space-between;
      flex-wrap: nowrap;
    }
    .boardtools-nav {
      gap: 1rem;
      justify-content: center;
    }
  }
</style>
