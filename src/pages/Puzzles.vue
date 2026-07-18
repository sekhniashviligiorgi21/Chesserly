<script setup>
  import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
  import Title from '../assets/Title.vue'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { collection, query, getDocs, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
  import { Chess } from 'chess.js'
  import { TheChessboard } from 'vue3-chessboard'
  import 'vue3-chessboard/style.css'
  import { startEngine, getEvaluation, cancelAnalysis } from '../engine/engine.js'

  // --- Theme ---
  const currentTheme = ref(localStorage.getItem('chesslab_theme') || 'brown')
  watch(currentTheme, (newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('chesslab_theme', newTheme)
  }, { immediate: true })

  const currentUser = ref(null)
  const allPuzzles = ref([])
  const puzzleQueue = ref([]) 
  const loading = ref(true)
  const puzzlesExhausted = ref(false)
  const solutionShown = ref(false)
  
  const currentPuzzle = shallowRef(null)
  const status = ref('idle') // 'idle', 'correct', 'wrong'
  const message = ref('Find the best move.')
  const blunderSan = ref('')
  
  // Computed visibility for Analysis to prevent cheating
  const showAnalysis = computed(() => status.value !== 'idle')

  // Persisted Session Stats
  const savedStats = JSON.parse(localStorage.getItem('chesslab_puzzle_session') || '{"solved":0,"failed":0}')
  const sessionStats = ref(savedStats)
  const streak = ref(Number(localStorage.getItem('chesslab_puzzle_streak')) || 0)

  const userRating = ref(Number(localStorage.getItem('chesslab_puzzle_rating')) || 1200)
  const boardAPI = shallowRef(null)
  const isFlipped = ref(false)

  // --- Engine & Analysis State ---
  let boardReady = false
  let engineReady = false
  const moveData = shallowRef(null)
  const isAnalyzing = ref(false)
  const currentDepth = ref(10)
  const targetDepth = ref(15)
  const sanLine = ref([])
  const bestMoveSan = ref('')
  const bestArrowSquares = ref(null)
  const height = ref(50)
  const cp = ref(0)

  const chess = new Chess()
  const bestChess = new Chess()

  const moveTree = {
    id: 0, san: null, uci: null, fen: chess.fen(), accuracy: null, analysisData: null, parent: null, children: []
  }
  let nodeIdCounter = 1
  const nodeMap = { 0: moveTree }
  const currentNode = shallowRef(moveTree)
  const movesListUCI = ref([])

  onMounted(async () => {
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
    await cancelAnalysis()
  })

  watch(sessionStats, (val) => {
    localStorage.setItem('chesslab_puzzle_session', JSON.stringify(val))
  }, { deep: true })

  watch(streak, (val) => {
    localStorage.setItem('chesslab_puzzle_streak', String(val))
  })

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
      localStorage.setItem('chesslab_puzzle_rating', String(userRating.value))
    } catch (e) {
      console.error("Failed to fetch rating:", e)
    }
  }

  async function updateRating(delta) {
    userRating.value += delta
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
    status.value = 'idle'
    solutionShown.value = false
    message.value = `Find the best move for ${currentPuzzle.value.turn === 'white' ? 'White' : 'Black'}.`
    
    // Reset tree
    chess.load(currentPuzzle.value.fen)
    moveTree.fen = currentPuzzle.value.fen
    moveTree.children = []
    nodeIdCounter = 1
    for (const key in nodeMap) {
      if (parseInt(key) !== 0) delete nodeMap[key]
    }
    currentNode.value = moveTree
    movesListUCI.value = []
    
    const blunderUci = currentPuzzle.value.playedMove || currentPuzzle.value.blunderMove
    if (blunderUci) {
      try {
        const tempChess = new Chess(currentPuzzle.value.fen)
        const moveObj = tempChess.move({
          from: blunderUci.slice(0, 2), to: blunderUci.slice(2, 4),
          promotion: blunderUci.length === 5 ? blunderUci[4] : undefined
        })
        blunderSan.value = moveObj ? moveObj.san : blunderUci
      } catch (e) {
        blunderSan.value = blunderUci 
      }
    } else {
      blunderSan.value = 'Unknown'
    }
    
    if (boardAPI.value) {
      const shouldBeFlipped = currentPuzzle.value.turn === 'black'
      if (shouldBeFlipped !== isFlipped.value) {
        boardAPI.value.toggleOrientation()
        isFlipped.value = shouldBeFlipped
      }
      boardAPI.value.setPosition(currentPuzzle.value.fen)
      boardAPI.value.hideMoves()
      
      // Draw the opponent's blunder arrow
      if (blunderUci && blunderUci.length >= 4) {
        boardAPI.value.drawMove(blunderUci.slice(0, 2), blunderUci.slice(2, 4), 'red')
      }
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
        
        // Draw the blunder arrow on first load
        const blunderUci = currentPuzzle.value.playedMove || currentPuzzle.value.blunderMove
        if (blunderUci && blunderUci.length >= 4) {
          boardAPI.value.drawMove(blunderUci.slice(0, 2), blunderUci.slice(2, 4), 'red')
        }
      })
    }
  }

  async function handleBothMoves(move) {
    if (status.value !== 'idle' || !currentPuzzle.value) {
      // Prevent making moves if puzzle is already solved/failed
      boardAPI.value.setPosition(currentNode.value.fen)
      return 
    }

    // Clear the blunder arrow when the user makes their move
    if (boardAPI.value) boardAPI.value.hideMoves() 

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
    await getAccuracy(true) // true = check puzzle solution
  }

  async function getAccuracy(checkSolution = false) {
    await cancelAnalysis() 
    
    const cached = currentNode.value.analysisData
    if (cached && cached.depth >= targetDepth.value) {
      moveData.value = cached
      currentDepth.value = cached.depth
      isAnalyzing.value = false
      evalSize()
      sanBest()
      uciLine()
      drawBestArrow()
      if (checkSolution) checkPuzzleSolution()
      return 
    }

    isAnalyzing.value = true
    bestArrowSquares.value = null

    const beforeFen = currentNode.value.parent ? currentNode.value.parent.fen : moveTree.fen
    const afterFen = currentNode.value.fen

    await getEvaluation(
      movesListUCI.value.length === 0 ? '' : movesListUCI.value.at(-1),
      movesListUCI.value.slice(0, -1),
      targetDepth.value,
      (result) => {
        moveData.value = result
        currentNode.value.accuracy = result.move_accuracy
        currentNode.value.analysisData = result 
        currentDepth.value = result.depth
        isAnalyzing.value = false
        
        evalSize()
        sanBest()
        uciLine()
        drawBestArrow()
        
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
    const playedSan = currentNode.value.san
    const dbBestMove = currentPuzzle.value.bestMove

    if (['brilliant', 'great', 'best', 'excellent'].includes(acc) || playedUci === dbBestMove) {
      streak.value += 1
      const basePoints = 15
      const streakBonus = (streak.value - 1) * 2
      const totalPoints = basePoints + streakBonus
      
      status.value = 'correct'
      sessionStats.value.solved++
      updateRating(totalPoints)
      
      if (playedUci === dbBestMove) {
        message.value = streak.value > 1 ? `Correct! +${totalPoints} Rating points (🔥 ${streak.value}x Streak)` : `Correct! +${basePoints} Rating points.`
      } else {
        message.value = `${playedSan} works too! ${bestMoveSan.value} was the alternative. +${totalPoints} points.`
      }

      // Mark puzzle as solved in Firestore
      if (currentUser.value && currentPuzzle.value.gameId && currentPuzzle.value.indexInArray !== undefined) {
        updateDoc(doc(db, `users/${currentUser.value.uid}/games`, currentPuzzle.value.gameId), {
          [`puzzles.${currentPuzzle.value.indexInArray}.solved`]: true
        }).catch(e => console.error("Failed to mark puzzle as solved:", e))
      }
    } else {
      streak.value = 0
      updateRating(-10)
      sessionStats.value.failed++
      status.value = 'wrong'
      message.value = 'Incorrect. That is not the best move. (-10 Rating)'
      
      // Reset board to puzzle start and show the red blunder arrow again
      if (boardAPI.value) {
        setTimeout(() => {
          boardAPI.value.setPosition(currentPuzzle.value.fen)
          const blunderUci = currentPuzzle.value.playedMove || currentPuzzle.value.blunderMove
          if (blunderUci && blunderUci.length >= 4) {
            boardAPI.value.drawMove(blunderUci.slice(0, 2), blunderUci.slice(2, 4), 'red')
          }
        }, 600)
      }
    }
  }

  function showSolution() {
    if (status.value === 'idle') {
      streak.value = 0
      updateRating(-10)
      sessionStats.value.failed++
    }
    status.value = 'wrong'
    solutionShown.value = true
    message.value = 'Solution shown. Keep practicing!'
    
    if (boardAPI.value && currentPuzzle.value) {
      boardAPI.value.setPosition(currentPuzzle.value.fen)
      const from = currentPuzzle.value.bestMove.slice(0, 2)
      const to = currentPuzzle.value.bestMove.slice(2, 4)
      boardAPI.value.drawMove(from, to, 'green')
    }
  }

  function retryPuzzle() {
    status.value = 'idle'
    message.value = `Find the best move for ${currentPuzzle.value.turn === 'white' ? 'White' : 'Black'}.`
    
    // Reset tree
    chess.load(currentPuzzle.value.fen)
    moveTree.children = []
    nodeIdCounter = 1
    for (const key in nodeMap) {
      if (parseInt(key) !== 0) delete nodeMap[key]
    }
    currentNode.value = moveTree
    movesListUCI.value = []
    
    if (boardAPI.value) {
      boardAPI.value.hideMoves()
      boardAPI.value.setPosition(currentPuzzle.value.fen)
      
      // Draw the opponent's blunder arrow again
      const blunderUci = currentPuzzle.value.playedMove || currentPuzzle.value.blunderMove
      if (blunderUci && blunderUci.length >= 4) {
        boardAPI.value.drawMove(blunderUci.slice(0, 2), blunderUci.slice(2, 4), 'red')
      }
    }
    getAccuracy()
  }

  function drawBestArrow() {
    if (!boardAPI.value || !bestArrowSquares.value) return
    if (status.value === 'idle') return // Don't show best engine arrow while solving![cite: 1]
    boardAPI.value.drawMove(bestArrowSquares.value.from, bestArrowSquares.value.to, 'green')
  }

  function uciLine() {
    sanLine.value = []
    bestArrowSquares.value = null
    let lineNum = 0
    const greedyChess = new Chess()
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
    const bestMoveBefore = moveData.value.best_move
    const bestMove = bestChess.move(bestMoveBefore, { sloppy: true })
    if (!bestMove) return
    bestMoveSan.value = bestMove.san
  }

  function prettyMove(move) {
    const pieces = { 'K': '♚', 'Q': '♛', 'R': '♜', 'B': '♝', 'N': '♞' }
    return move ? move.replace(/[KQRBN]/g, p => pieces[p]) : ''
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
        <router-link to="/import" class="tool-btn primary">Import & Analyze a Game</router-link>
      </div>
      <p class="muted">ChessLab automatically creates puzzles based on mistakes you make in your imported games.</p>
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
            <!-- Hidden visibily while solving to not shift layout -->
            <div class="evalbar" :style="{ visibility: showAnalysis ? 'visible' : 'hidden' }">
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
            </div>
          </div>

          <div class="player-bar bottom">
            <span class="player-color-dot" :class="currentPuzzle?.turn === 'white' ? 'black' : 'white'"></span>
            <span class="player-name">Your Past Self</span>
          </div>
        </div>
      </div>
      
      <!-- Right Sidebar: Puzzle Controls & Engine Analysis -->
      <div class="puzzle-sidebar">
        
        <!-- Stats Bar -->
        <div class="sidebar-header">
          <div class="rating-badge">
            <span class="rating-label">Puzzle Rating</span>
            <span class="rating-value">{{ userRating }}</span>
          </div>
          <div class="streak-badge" v-if="streak > 1">
            🔥 {{ streak }} Streak
          </div>
        </div>

        <div class="session-stats-grid">
          <div class="stat-card">
            <span class="stat-val solved">{{ sessionStats.solved }}</span>
            <span class="stat-key">Solved</span>
          </div>
          <div class="stat-card">
            <span class="stat-val failed">{{ sessionStats.failed }}</span>
            <span class="stat-key">Failed</span>
          </div>
          <div class="stat-card">
            <span class="stat-val remaining">{{ puzzleQueue.length }}</span>
            <span class="stat-key">Remaining</span>
          </div>
        </div>

        <!-- Blunder Context -->
        <div class="blunder-context">
          <span class="context-label">In your actual game, you played:</span>
          <span class="blunder-move">{{ blunderSan }}</span>
          <span class="context-desc">Find the punishment!</span>
        </div>

        <!-- Status Message -->
        <div class="status-box" :class="status">
          <span class="status-icon" v-if="status === 'correct'">✓</span>
          <span class="status-icon" v-if="status === 'wrong'">✗</span>
          <p>{{ message }}</p>
        </div>

        <!-- Action Buttons -->
        <div class="action-buttons">
          <template v-if="status === 'idle'">
            <button class="tool-btn outline" @click="showSolution">Show Solution (-10)</button>
          </template>
          
          <template v-else-if="status === 'wrong'">
            <button class="tool-btn outline" @click="retryPuzzle" v-if="!solutionShown">Retry Puzzle</button>
            <button class="tool-btn outline" @click="showSolution" v-if="!solutionShown">Show Solution</button>
            <button class="tool-btn primary" @click="loadRandomPuzzle">Next Puzzle →</button>
          </template>

          <template v-else-if="status === 'correct'">
            <button class="tool-btn primary" @click="loadRandomPuzzle">Next Puzzle →</button>
          </template>
        </div>

        <!-- Analysis Panel (Only visible after attempt) -->
        <div class="analysis-panel" v-if="showAnalysis">
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
              <span v-for="(move, idx) in sanLine" :key="'best-' + idx" class="line-move">
                {{ prettyMove(move) }}&nbsp;
              </span>
            </div>
          </div>
          <div v-else class="move-data">
            <p class="depthnum">Waiting for engine...</p>
          </div>
        </div>

      </div>
    </template>
  </div>
</template>

<style scoped>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');

  .grid-layout {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    padding: clamp(0.5rem, 3vw, 1rem);
    display: grid;
    grid-template-columns: 1fr;
    grid-template-areas:
      "title"
      "board"
      "sidebar";
    gap: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
    box-sizing: border-box;
  }

  @media (min-width: 900px) {
    .grid-layout {
      grid-template-columns: 2fr 1.2fr;
      grid-template-areas:
        "title sidebar"
        "board sidebar";
      gap: 2rem;
    }
  }

  .title-slot { grid-area: title; min-width: 0; }
  .board-area { grid-area: board; display: flex; justify-content: center; width: 100%; min-width: 0; }

  /* Empty State / Exhausted State */
  .empty-state {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 50vh;
    gap: 1rem;
    color: rgba(244, 240, 227, 0.7);
    font-size: 1rem;
    text-align: center;
    padding: 3rem 1rem;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45);
  }

  .exhausted-state h2 { font-family: serif; color: #f5f5dc; font-size: 2rem; margin: 0; }
  .trophy-icon { font-size: 4rem; text-shadow: 0 4px 15px rgba(255, 215, 0, 0.3); }
  .exhausted-actions { margin-top: 1rem; }
  .empty-state .muted { font-size: 0.85rem; color: rgba(244, 240, 227, 0.4); margin-top: 1.5rem; max-width: 400px; }

  /* Loading Spinner */
  .loading-spinner { position: relative; width: 56px; height: 56px; margin-bottom: 1rem; }
  .spinner-ring { position: absolute; inset: 0; border-radius: 50%; border: 3px solid transparent; border-top-color: var(--text-highlight); animation: spinRing 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite; }
  .spinner-ring:nth-child(2) { inset: 7px; border-top-color: #a8d97a; animation-duration: 1.6s; animation-direction: reverse; }
  .spinner-ring:nth-child(3) { inset: 14px; border-top-color: #f4f0e3; animation-duration: 2s; }
  @keyframes spinRing { to { transform: rotate(360deg); } }

  /* Board Area */
  .board-wrapper { position: relative; width: 100%; max-width: min(95vw, 42rem); min-width: 0; margin: 0 auto; display: flex; flex-direction: column; }
  .board-col { flex: 1 1 auto; min-width: 0; position: relative; display: flex; flex-direction: column; }
  .game-board { width: 100% !important; height: auto !important; aspect-ratio: 1 / 1 !important; display: block; }

  :deep(.cg-wrap) { overflow: hidden; width: 100% !important; height: 100% !important; box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4); border-radius: 8px; }
  :deep(cg-board) { background: conic-gradient(var(--board-dark) 90deg, var(--board-light) 90deg 180deg, var(--board-dark) 180deg 270deg, var(--board-light) 270deg) !important; background-size: 25% 25% !important; }

  .board-row { display: flex; justify-content: center; gap: 0.75rem; width: 100%; }
  
  .evalbar { width: clamp(24px, 4vw, 40px); flex-shrink: 0; position: relative; display: flex; flex-direction: column; transition: visibility 0s; }
  .evalbar-inner { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; border-radius: 10px; overflow: hidden; box-shadow: inset 0 2px 5px rgba(0,0,0,0.5); }
  .blackeval, .whiteeval { width: 100%; transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1); }
  .blackeval { background-color: #38412e; }
  .whiteeval { background-color: #626949; }
  .evalnum { font-family: "JetBrains Mono", monospace; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: clamp(0.62rem, 1vw, 0.85rem); font-weight: 600; color: #fff8ef; text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.6); background: rgba(0, 0, 0, 0.3); padding: 0.25rem 0.4rem; border-radius: 6px; backdrop-filter: blur(4px); z-index: 10; white-space: nowrap; width: max-content; }

  .player-bar { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.7rem; margin-bottom: 0.2rem; border-radius: 8px; background: rgba(0, 0, 0, 0.22); color: #f4f0e3; font-size: clamp(0.82rem, 1.8vw, 0.95rem); width: 100%; box-sizing: border-box; }
  .player-bar.bottom { margin-bottom: 0; margin-top: 0.2rem; }
  .player-color-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3); }
  .player-color-dot.white { background: #f4f0e3; }
  .player-color-dot.black { background: #1a1a1a; }
  .player-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Right Sidebar layout */
  .puzzle-sidebar {
    grid-area: sidebar;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border-radius: 16px;
    padding: 1.5rem;
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.08);
    height: max-content;
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .rating-badge { display: flex; flex-direction: column; }
  .rating-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; color: rgba(244, 240, 227, 0.6); }
  .rating-value { font-family: "JetBrains Mono", monospace; font-size: 2rem; font-weight: 700; color: var(--text-highlight); line-height: 1; }
  
  .streak-badge { background: rgba(255, 165, 0, 0.15); color: #ffb74d; font-size: 0.85rem; font-weight: 700; padding: 0.4rem 0.8rem; border-radius: 8px; border: 1px solid rgba(255, 165, 0, 0.3); box-shadow: 0 4px 10px rgba(255, 165, 0, 0.1); }

  .session-stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; }
  .stat-card { background: linear-gradient(135deg, var(--list-1), var(--list-2)); border-radius: 10px; padding: 0.75rem 0.5rem; text-align: center; display: flex; flex-direction: column; gap: 0.25rem; box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25); }
  .stat-val { font-family: "JetBrains Mono", monospace; font-size: clamp(1.2rem, 3vw, 1.5rem); font-weight: 700; }
  .stat-val.solved { color: #a8d97a; }
  .stat-val.failed { color: #ff8a80; }
  .stat-val.remaining { color: #f4f0e3; }
  .stat-key { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 1px; color: rgba(244, 240, 227, 0.5); }

  .blunder-context { display: flex; flex-direction: column; gap: 0.25rem; background: rgba(255, 100, 90, 0.05); border: 1px dashed rgba(255, 100, 90, 0.3); padding: 1rem; border-radius: 10px; }
  .context-label { font-size: 0.8rem; color: rgba(244, 240, 227, 0.7); }
  .blunder-move { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 1.3rem; color: #ff8a80; margin: 0.2rem 0;}
  .context-desc { font-size: 0.8rem; font-weight: 600; color: #f4f0e3; }

  /* Status Box */
  .status-box {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    border-radius: 10px;
    font-weight: 600;
    font-size: 1.05rem;
    transition: all 0.3s ease;
  }
  .status-box.idle { background: rgba(255, 255, 255, 0.05); color: #f4f0e3; border: 1px solid rgba(255,255,255,0.1); }
  .status-box.correct { background: rgba(168, 217, 122, 0.15); color: #a8d97a; border: 1px solid rgba(168, 217, 122, 0.3); }
  .status-box.wrong { background: rgba(255, 138, 128, 0.15); color: #ff8a80; border: 1px solid rgba(255, 138, 128, 0.3); }
  .status-box p { margin: 0; flex: 1; }
  .status-icon { font-size: 1.4rem; line-height: 1; }

  /* Actions */
  .action-buttons { display: flex; flex-direction: column; gap: 0.75rem; margin-top: auto; }
  .tool-btn { text-decoration: none; text-align: center; border: none; border-radius: 8px; padding: 0.85rem 1.5rem; font-size: clamp(0.9rem, 2vw, 1.05rem); font-weight: 600; cursor: pointer; transition: all 0.2s ease; display: block;}
  .tool-btn.outline { background: rgba(0, 0, 0, 0.2); color: #e8e8d0; border: 1px solid rgba(255, 255, 255, 0.1); }
  .tool-btn.outline:hover { background: rgba(255, 255, 255, 0.1); }
  
  .tool-btn.primary { background: var(--btn-active); color: #f5f5dc; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3); }
  .tool-btn.primary:hover { background: var(--btn-idle); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }

  /* Analysis Area (Hidden till solved/failed) */
  .analysis-panel {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 12px;
    padding: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.05);
    margin-top: 0.5rem;
  }
  
  .analyzis-header { margin-bottom: 0.5rem; }
  .analyzis-title { font-family: serif; color: #f5f5dc; font-weight: 700; text-transform: uppercase; font-size: 1rem; margin: 0; display: flex; align-items: center; gap: 0.5rem; letter-spacing: 1px;}
  
  .thinking-dot { width: 0.4rem; height: 0.4rem; border-radius: 50%; background: #6ad13f; box-shadow: 0 0 8px rgba(106, 209, 63, 0.9); animation: thinkingPulse 1s ease-in-out infinite; }
  @keyframes thinkingPulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.15); } }

  .depthnum { font-family: 'Inter', sans-serif; color: rgba(245, 245, 220, 0.6); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin: 0 0 0.5rem; }
  .line { font-family: "JetBrains Mono", monospace; display: flex; white-space: nowrap; align-items: center; gap: 0.5rem; font-size: 0.9rem; padding: 0.4rem; background: rgba(0, 0, 0, 0.25); border-radius: 8px; color: #eae4d8; box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.4); overflow-x: auto; scrollbar-width: thin; }
  .evalnum2 { font-size: 0.95rem; color: #171717; background-color: #606847; border-radius: 6px; flex-shrink: 0; padding: 0 0.4rem; text-align: center; }
  .line-move { padding: 0 2px; }
</style>