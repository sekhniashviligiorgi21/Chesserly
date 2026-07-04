<script setup>
  import { ref, onMounted } from 'vue'
  import Title from "../assets/Title.vue"
  import { Chess } from 'chess.js'   
  import { TheChessboard } from 'vue3-chessboard'  
  import 'vue3-chessboard/style.css'; 

  const username = ref(null)
  const year = ref(null)
  const month = ref(null)
  const games = ref([])
  const selectedGame = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const gameUci = ref([])
  const reviewMoves = ref([])
  const reviewIndex = ref(0)
  const moveslist = ref([])
  const chess = new Chess()

  async function chessImport() {
    loading.value = true
    error.value = null
    games.value = []
    try {
      const paddedMonth = String(month.value).padStart(2, '0')
      const res = await fetch(
        `https://api.chess.com/pub/player/${username.value}/games/${year.value}/${paddedMonth}`
      )
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`)
      const data = await res.json()
      games.value = data.games || []
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  function selectGame(game) {
    selectedGame.value = game
    gameUci.value = convertPgnToUci(game.pgn)
    reviewMoves.value = gameUci.value
    reviewIndex.value = 0
    chess.reset()
    boardAPI.value?.setPosition(chess.fen())
    const tempChess = new Chess()
    moveslist.value = gameUci.value.map(uci => {
      const m = tempChess.move(uci, { sloppy: true })
      return m ? m.san : uci
    })
  }


  function replayMoves() {
    chess.reset()
    const tempChess = new Chess()
    moveslist.value = reviewMoves.value.map(uci => {
      const m = tempChess.move(uci, { sloppy: true })
      return m ? m.san : uci
    })
  }

  function convertPgnToUci(pgn) {
    const c = new Chess()
    c.loadPgn(pgn)
    return c.history({ verbose: true }).map(move => {
      let uci = move.from + move.to
      if (move.promotion) uci += move.promotion
      return uci
    })
  }

  function formatResult(game) {
    const isWhite = game.white.username.toLowerCase() === username.value.toLowerCase()
    const me = isWhite ? game.white : game.black
    const opponent = isWhite ? game.black : game.white
    const result = me.result === 'win' ? '1-0' : me.result === 'resigned' || me.result === 'checkmated' ? '0-1' : '½-½'
    return { opponent: opponent.username, result, myColor: isWhite ? 'White' : 'Black', myRating: me.rating, oppRating: opponent.rating }
  }
</script>

<template>
  <div class="grid-layout">
    <Title/>
    <div class="content-area">
        <div class="import-container">
          <h1 class="import-title">Import your game</h1>
          <div class="controls">
            <input v-model="username" placeholder="Chess.com username" class="input" />
            <input v-model="year" placeholder="Enter the year" class="input"/>
            <select v-model="month" class="input">
              <option value="month" disabled>month</option>
              <option v-for="m in 12" :key="m" :value="m">{{ String(m).padStart(2, '0') }}</option>
            </select>
            <button class="import_btn" @click="chessImport" :disabled="loading">
              {{ loading ? 'Loading...' : 'Import' }}
            </button>
          </div>

          <div v-if="error" class="error">{{ error }}</div>

          <div v-if="games.length" class="games-list">
            <div
              v-for="(game, i) in games"
              :key="i"
              class="game-row"
              :class="{ selected: selectedGame === game }"
              @click="selectGame(game)"
            >
              <span class="color-dot" :class="formatResult(game).myColor.toLowerCase()"></span>
              <span class="opponent">vs {{ formatResult(game).opponent }}</span>
              <span class="rating">{{ formatResult(game).myRating }} vs {{ formatResult(game).oppRating }}</span>
              <span class="result" :class="formatResult(game).result">{{ formatResult(game).result }}</span>
              <span class="time-class">{{ game.time_class }}</span>
          </div>

          <div v-if="selectedGame" class="selection-bar">
            <span class="selected-msg">✓ Game selected</span>
          </div>
          <div v-else-if="!loading" class="empty">No game selected yet.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .grid-layout {
    padding: 1rem;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1.5rem;
    max-width: 1600px;
    margin: 0 auto;
  }

  .content-area {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 1.5rem;
  }

  .board-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: center;
    flex-shrink: 0;
  }

  .analyze-here-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  .analyze-here-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .import-container {
    display: flex;
    padding: 1rem;
    align-items: center;
    flex-direction: column;
    gap: 1rem;
    border: 1px solid #8c613f;
    border-radius: 20px;
    background-color: #83542f;
  }

  .import-title {
    text-align: center;
    color: #f5f5dc;
  }

  .controls {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .input {
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    border: 1px solid #444;
    background: #1e1e1e;
    color: white;
  }

  .import_btn {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    background: #343f2a;
    color: #fff;
    border: none;
    cursor: pointer;
  }

  .import_btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .games-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 300px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: #353e2a #1e1e1e;
    width: 100%;
  }

  .game-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    background: #1e1e1e;
    cursor: pointer;
    transition: background 0.2s;
  }

  .game-row:hover { background: #2a2a2a; }

  .game-row.selected {
    background: #2a3d2a;
    border: 1px solid #5c9e5c;
  }

  .color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .color-dot.white { background: #fff; }
  .color-dot.black { background: #555; border: 1px solid #888; }

  .opponent { flex: 1; font-weight: 500; }
  .rating { color: #aaa; font-size: 0.85rem; }
  .time-class { color: #aaa; font-size: 0.8rem; text-transform: capitalize; }
  .result { font-weight: bold; font-size: 0.9rem; }
  .error { color: red; }

  .selection-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.6rem 0.75rem;
    background: #1e1e1e;
    border-radius: 8px;
    border: 1px solid #5c9e5c;
    width: 100%;
  }

  .selected-msg {
    color: #5c9e5c;
    font-weight: 500;
  }

  .empty {
    color: #5d9e5d;
    padding: 0.6rem 0.75rem;
    background: #1e1e1e;
    border-radius: 8px;
    border: 1px solid #5c9e5c;
  }
</style>


