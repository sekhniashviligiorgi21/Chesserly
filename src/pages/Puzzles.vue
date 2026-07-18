<script setup>
  import { ref, shallowRef, computed, onMounted, watch, nextTick } from 'vue'
  import Title from '../assets/Title.vue'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { collection, query, getDocs, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
  import { Chess } from 'chess.js'
  import { TheChessboard } from 'vue3-chessboard'
  import 'vue3-chessboard/style.css'

  // --- Apply theme instantly ---
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
  
  const currentPuzzle = shallowRef(null)
  const status = ref('idle') // 'idle', 'correct', 'wrong'
  const message = ref('Find the best move for your side.')
  const messageColor = ref('#f4f0e3')
  const blunderSan = ref('')
  
  const userRating = ref(Number(localStorage.getItem('chesslab_puzzle_rating')) || 1200)
  const boardAPI = shallowRef(null)
  const isFlipped = ref(false)

  // Session Stats & Streaks
  const sessionStats = ref({ solved: 0, failed: 0 })
  const streak = ref(0)

  // Eval Bar State
  const evalHeight = ref(50)
  const evalNumber = ref('0.0')

  onMounted(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser.value = user
        await fetchRating()
        await fetchPuzzles()
      } else {
        currentUser.value = null
        allPuzzles.value = []
        puzzleQueue.value = []
      }
      loading.value = false
    })
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
      sessionStats.value = { solved: 0, failed: 0 }
      streak.value = 0
      puzzlesExhausted.value = false
      
      if (allPuzzles.value.length > 0) {
        prepareQueue()
        loadRandomPuzzle()
      } else {
        message.value = 'No puzzles left! Analyze more games to generate new ones.'
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

  function updateEvalBar() {
    if (!currentPuzzle.value || !currentPuzzle.value.eval) {
      evalHeight.value = 50
      evalNumber.value = '0.0'
      return
    }
    const evalType = currentPuzzle.value.eval.type
    const evalValue = currentPuzzle.value.eval.value
    if (evalType === 'mate') {
      if (evalValue >= 0) { evalHeight.value = 0; evalNumber.value = `M${evalValue}` }
      else { evalHeight.value = 100; evalNumber.value = `M${evalValue}` }
    } else {
      const cp = Math.max(-800, Math.min(800, evalValue))
      evalHeight.value = 50 - (cp / 800) * 50
      evalNumber.value = (cp / 100).toFixed(2)
    }
  }

  function loadRandomPuzzle() {
    if (puzzleQueue.value.length === 0) {
      puzzlesExhausted.value = true
      status.value = 'correct' 
      message.value = "No more puzzles left. Analyze more games to see more!"
      messageColor.value = '#a8d97a'
      return
    }

    currentPuzzle.value = puzzleQueue.value.pop()
    status.value = 'idle'
    message.value = `Find the best move for ${currentPuzzle.value.turn === 'white' ? 'White' : 'Black'}.`
    messageColor.value = '#f4f0e3'
    
    evalHeight.value = 50
    evalNumber.value = '0.0'
    
    const blunderUci = currentPuzzle.value.playedMove || currentPuzzle.value.blunderMove || currentPuzzle.value.userMove
    if (blunderUci) {
      try {
        const tempChess = new Chess(currentPuzzle.value.fen)
        const moveObj = tempChess.move({
          from: blunderUci.slice(0, 2),
          to: blunderUci.slice(2, 4),
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
    }
  }

  function onBoardCreated(api) {
    boardAPI.value = api
    if (currentPuzzle.value) {
      nextTick(() => {
        const shouldBeFlipped = currentPuzzle.value.turn === 'black'
        if (shouldBeFlipped !== isFlipped.value) {
          boardAPI.value.toggleOrientation()
          isFlipped.value = shouldBeFlipped
        }
        boardAPI.value.setPosition(currentPuzzle.value.fen)
      })
    }
  }

  async function handleMove(move) {
    if (status.value !== 'idle' || !currentPuzzle.value) return 

    const uci = move.promotion ? `${move.from}${move.to}${move.promotion}` : `${move.from}${move.to}`
    
    if (uci === currentPuzzle.value.bestMove) {
      streak.value += 1
      const basePoints = 15
      const streakBonus = (streak.value - 1) * 2
      const totalPoints = basePoints + streakBonus
      
      status.value = 'correct'
      message.value = streak.value > 1 ? `Correct! +${totalPoints} points (🔥 ${streak.value}x Streak).` : `Correct! +${basePoints} Rating points.`
      messageColor.value = '#a8d97a'
      updateRating(totalPoints)
      sessionStats.value.solved++
      
      updateEvalBar()

      if (currentUser.value && currentPuzzle.value.gameId && currentPuzzle.value.indexInArray !== undefined) {
        try {
          const gameRef = doc(db, `users/${currentUser.value.uid}/games`, currentPuzzle.value.gameId)
          await updateDoc(gameRef, {
            [`puzzles.${currentPuzzle.value.indexInArray}.solved`]: true
          })
        } catch (e) {
          console.error("Failed to mark puzzle as solved:", e)
        }
      }

    } else {
      streak.value = 0
      if (status.value !== 'wrong') {
        updateRating(-10)
        sessionStats.value.failed++
        message.value = 'Not the best move. -10 Rating points.'
        messageColor.value = '#ffb0a8'
      } else {
        message.value = 'Still not the best move. Try again or view the solution.'
      }
      
      status.value = 'wrong'
      updateEvalBar()
      
      if (boardAPI.value) {
        boardAPI.value.setPosition(currentPuzzle.value.fen)
        const from = currentPuzzle.value.bestMove.slice(0, 2)
        const to = currentPuzzle.value.bestMove.slice(2, 4)
        boardAPI.value.drawMove(from, to, 'green')
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
    message.value = 'Better luck next time!'
    messageColor.value = '#ffb0a8'
    
    updateEvalBar()
    
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
    messageColor.value = '#f4f0e3'
    evalHeight.value = 50
    evalNumber.value = '0.0'
    if (boardAPI.value) {
      boardAPI.value.hideMoves()
      boardAPI.value.setPosition(currentPuzzle.value.fen)
    }
  }
</script>

<template>
  <div class="grid-layout">
    <Title class="title-slot" />
    
    <div class="board-area">
      <div v-if="loading" class="empty-state">
        <div class="loading-spinner"><div class="spinner-ring"></div><div class="spinner-ring"></div><div class="spinner-ring"></div></div>
        <p>Loading your puzzles...</p>
      </div>

      <div v-else-if="!currentUser" class="empty-state"><p>Please log in to access your puzzles.</p></div>
      
      <div v-else-if="allPuzzles.length === 0 && puzzlesExhausted" class="empty-state">
        <p>No puzzles left!</p>
        <p class="muted">Analyze more games to automatically generate new puzzles.</p>
      </div>

      <div v-else class="board-wrapper">
        <div class="player-bar">
          <span class="player-color-dot" :class="currentPuzzle?.turn"></span>
          <span class="player-name">{{ currentPuzzle?.turn === 'white' ? 'White to Play' : 'Black to Play' }}</span>
        </div>
        
        <div class="board-row">
          <div class="evalbar">
            <div class="evalbar-inner">
              <template v-if="!isFlipped">
                <div class="blackeval" :style="{ height: evalHeight + '%' }"></div>
                <div class="whiteeval" :style="{ height: (100 - evalHeight) + '%' }"></div>
              </template>
              <template v-else>
                <div class="whiteeval" :style="{ height: (100 - evalHeight) + '%' }"></div>
                <div class="blackeval" :style="{ height: evalHeight + '%' }"></div>
              </template>
            </div>
            <p class="evalnum">{{ evalNumber }}</p>
          </div>

          <div class="board-col">
            <TheChessboard 
              class="game-board"
              @move="handleMove" 
              @board-created="onBoardCreated" 
              :board-config="{ coordinates: true, animation: { enabled: false } }" 
            />
          </div>
        </div>

        <div class="player-bar bottom">
          <span class="player-color-dot" :class="currentPuzzle?.turn === 'white' ? 'black' : 'white'"></span>
          <span class="player-name">Your Past Self</span>
          <span class="player-rating">🏆 {{ userRating }}</span>
          <span v-if="streak > 1" class="streak-badge">🔥 {{ streak }}</span>
        </div>
        
        <div class="boardtools">
          <button v-if="status === 'idle'" class="tool-btn" @click="showSolution">
            Show Solution
          </button>
          <button v-else-if="status === 'wrong'" class="tool-btn" @click="retryPuzzle">
            Retry Puzzle
          </button>
          
          <button 
            class="tool-btn primary" 
            @click="loadRandomPuzzle" 
            :disabled="puzzlesExhausted"
          >
            <span v-if="puzzlesExhausted">All Solved!</span>
            <span v-else>Next Puzzle →</span>
          </button>
        </div>
      </div>
    </div>
    
    <div class="analysis-container">
      <div class="analyze">
        <div class="analyzis-header">
          <h2 class="analyzis">Puzzle</h2>
        </div>
        <div class="move-data">
          <p class="accuracydescribtion" :style="{color: messageColor}">{{ message }}</p>
          
          <div class="blunder-context" v-if="currentPuzzle && !puzzlesExhausted">
            <span class="context-label">In your actual game, you played:</span>
            <span class="blunder-move">{{ blunderSan }}</span>
          </div>
        </div>
      </div>

      <div class="moves">
        <div class="movesButtons">
          <button class="movehistory active">Session</button>
        </div>
        
        <div class="report" style="padding: 1rem;">
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
        </div>
      </div>
    </div>
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

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 60vh;
    gap: 0.5rem;
    color: rgba(244, 240, 227, 0.6);
    font-size: 1rem;
    text-align: center;
    padding: 3rem 1rem;
  }

  .empty-state .muted {
    font-size: 0.85rem;
    color: rgba(244, 240, 227, 0.4);
  }

  .loading-spinner {
    position: relative;
    width: 56px;
    height: 56px;
    margin-bottom: 1rem;
  }

  .spinner-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 3px solid transparent;
    border-top-color: var(--text-highlight);
    animation: spinRing 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }
  .spinner-ring:nth-child(2) { inset: 7px; border-top-color: #a8d97a; animation-duration: 1.6s; animation-direction: reverse; }
  .spinner-ring:nth-child(3) { inset: 14px; border-top-color: #f4f0e3; animation-duration: 2s; }
  @keyframes spinRing { to { transform: rotate(360deg); } }

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
    box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
  }

  .blackeval, .whiteeval {
    width: 100%;
    transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .blackeval { background-color: #38412e; }
  .whiteeval { background-color: #626949; }

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

  .streak-badge {
    background: rgba(255, 165, 0, 0.2);
    color: #ffb74d;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    border: 1px solid rgba(255, 165, 0, 0.4);
  }

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
    position: relative;
  }

  .tool-btn {
    background-color: var(--btn-idle);
    border: none;
    border-radius: 8px;
    padding: 0.6rem 1.5rem;
    font-size: clamp(0.85rem, 2vw, 1rem);
    font-weight: 600;
    color: #e8e8d0;
    cursor: pointer;
    transition: all 0.2s ease;
    flex: 1;
  }

  .tool-btn.primary {
    background-color: var(--btn-active);
    color: #f5f5dc;
  }

  .tool-btn:hover:not(:disabled) {
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  .tool-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .analysis-container { grid-area: analysis; display: flex; flex-direction: column; gap: 1rem; min-width: 0; }

  .analyze {
    border-radius: 15px;
    width: 100%;
    max-width: 500px;
    min-height: 180px;
    padding-bottom: 1rem;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    box-sizing: border-box;
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin: auto;
  }

  @media (min-width: 1200px) { .analyze { max-width: 20rem; } }

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
    margin: 0;
  }

  .accuracydescribtion {
    font-weight: 500;
    text-align: center;
    font-size: clamp(1rem, 2.1vw, 1.2rem);
    margin-top: 1rem;
    padding: 0 1rem;
    word-wrap: break-word;
    transition: color 0.3s ease;
  }

  .move-data { padding: 0 1rem; }

  .blunder-context {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    background: rgba(255, 100, 90, 0.05);
    border: 1px dashed rgba(255, 100, 90, 0.3);
    padding: 0.85rem 1rem;
    border-radius: 8px;
    margin-top: 1.5rem;
  }

  .context-label {
    font-size: 0.75rem;
    color: rgba(244, 240, 227, 0.6);
  }

  .blunder-move {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    font-size: 1.1rem;
    color: #ff8a80;
  }

  .moves {
    margin-top: 10px;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border-radius: 16px;
    width: 100%;
    max-width: 500px;
    height: clamp(250px, 40vh, 400px);
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    overflow-y: auto;
    overflow-x: hidden;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin: 0 auto;
    scrollbar-width: thin;
  }

  @media (min-width: 1200px) { .moves { max-width: 20rem; } }

  .movesButtons {
    display: flex;
    justify-content: center;
    gap: 0.4rem;
    padding: 0 0.5rem;
  }

  .movehistory.active {
    font-family: serif;
    text-align: center;
    color: #f5f5dc;
    font-weight: 700;
    text-transform: uppercase;
    margin: 12px 0;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
    letter-spacing: 1px;
    padding: 0.5rem 0.4rem;
    border-radius: 5px;
    background-color: var(--btn-active);
    border: none;
    font-size: clamp(0.7rem, 2vw, 0.95rem);
    width: 100%;
    cursor: pointer;
  }

  .session-stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
  }

  .stat-card {
    background: linear-gradient(135deg, var(--list-1), var(--list-2));
    border-radius: 12px;
    padding: 1rem 0.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
  }

  .stat-val {
    font-family: "JetBrains Mono", monospace;
    font-size: clamp(1.3rem, 4vw, 1.8rem);
    font-weight: 700;
  }

  .stat-val.solved { color: #a8d97a; }
  .stat-val.failed { color: #ff8a80; }
  .stat-val.remaining { color: #f4f0e3; }

  .stat-key {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: rgba(244, 240, 227, 0.5);
  }
</style>