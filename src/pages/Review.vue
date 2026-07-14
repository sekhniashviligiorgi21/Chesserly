<script setup>
  import { ref, computed, watch, onMounted } from 'vue'
  import Title from '../assets/Title.vue'
  import { Chess } from 'chess.js'
  import { useRouter } from 'vue-router'
  import { auth, db } from '../firebase'
  import { 
    onAuthStateChanged, 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signOut 
  } from 'firebase/auth'
  import { 
    collection, 
    addDoc, 
    query, 
    where, 
    getDocs, 
    serverTimestamp,
    deleteDoc,
    doc,
    orderBy
  } from 'firebase/firestore'

  const router = useRouter()

  const USERNAME_STORAGE_KEY = 'chesslab_username'

  const username = ref(localStorage.getItem(USERNAME_STORAGE_KEY) || '')

  watch(username, (val) => {
    localStorage.setItem(USERNAME_STORAGE_KEY, val)
  })

  const year = ref('')
  const month = ref('month')
  const games = ref([])
  const selectedGame = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const gameUci = ref([])
  const reviewMoves = ref([])
  const reviewIndex = ref(0)
  const moveslist = ref([])
  const chess = new Chess()
  const importSite = ref('chess.com')
  const importMode = ref('last') // 'last' | 'range'

  // --- Auth State ---
  const currentUser = ref(null)
  const authEmail = ref('')
  const authPassword = ref('')
  const isRegistering = ref(false)
  const authError = ref(null)

  // --- Saved Games State ---
  const savedGames = ref([])

  onMounted(() => {
    onAuthStateChanged(auth, (user) => {
      currentUser.value = user
      if (user) {
        fetchSavedGames()
      } else {
        savedGames.value = []
      }
    })
  })

  async function handleAuth() {
    authError.value = null
    try {
      if (isRegistering.value) {
        await createUserWithEmailAndPassword(auth.value || auth, authEmail.value, authPassword.value)
      } else {
        await signInWithEmailAndPassword(auth.value || auth, authEmail.value, authPassword.value)
      }
      authEmail.value = ''
      authPassword.value = ''
    } catch (e) {
      authError.value = e.message
    }
  }

  async function handleLogout() {
    await signOut(auth)
  }

  async function saveCurrentGame() {
    if (!currentUser.value || !selectedGame.value) return
    loading.value = true
    try {
      const gameData = {
        userId: currentUser.value.uid,
        pgn: selectedGame.value.pgn,
        white: selectedGame.value.white,
        black: selectedGame.value.black,
        time_class: selectedGame.value.time_class,
        createdAt: serverTimestamp()
      }
      await addDoc(collection(db, 'games'), gameData)
      alert('Game saved to your library!')
      fetchSavedGames()
    } catch (e) {
      console.error(e)
      alert('Failed to save game.')
    } finally {
      loading.value = false
    }
  }

  async function fetchSavedGames() {
    if (!currentUser.value) return
    const q = query(
      collection(db, 'games'), 
      where('userId', '==', currentUser.value.uid),
      orderBy('createdAt', 'desc')
    )
    const querySnapshot = await getDocs(q)
    savedGames.value = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }))
  }

  async function deleteSavedGame(gameId, event) {
    event.stopPropagation()
    if (!confirm('Delete this game?')) return
    try {
      await deleteDoc(doc(db, 'games', gameId))
      savedGames.value = savedGames.value.filter(g => g.id !== gameId)
    } catch (e) {
      console.error(e)
    }
  }

  // --- PGN / FEN import state ---
  const pgnText = ref('')
  const fenText = ref('')

  const isPasteSource = computed(() => importSite.value === 'pgn' || importSite.value === 'fen' || importSite.value === 'library')

  function normalizeLichessLine(line) {
    const lGame = JSON.parse(line)

    let wRes = 'draw'
    let bRes = 'draw'
    if (lGame.winner === 'white') { wRes = 'win'; bRes = 'lose' }
    else if (lGame.winner === 'black') { wRes = 'lose'; bRes = 'win' }

    return {
      pgn: lGame.pgn || "",
      time_class: lGame.speed || "unknown",
      white: {
        username: lGame.players?.white?.user?.name || "Anonymous",
        rating: lGame.players?.white?.rating || 0,
        result: wRes
      },
      black: {
        username: lGame.players?.black?.user?.name || "Anonymous",
        rating: lGame.players?.black?.rating || 0,
        result: bRes
      }
    }
  }

  async function fetchChessComRange(user, yr, mo) {
    const paddedMonth = String(mo).padStart(2, '0')
    const res = await fetch(`https://api.chess.com/pub/player/${user}/games/${yr}/${paddedMonth}`)
    if (!res.ok) throw new Error('Failed to fetch from Chess.com')
    const data = await res.json()
    return data.games || []
  }

  async function fetchChessComLast(user) {
    const archivesRes = await fetch(`https://api.chess.com/pub/player/${user}/games/archives`)
    if (!archivesRes.ok) throw new Error('Failed to fetch archives from Chess.com')
    const archivesData = await archivesRes.json()
    const archives = archivesData.archives || []
    if (!archives.length) throw new Error('No games found for this player.')

    const lastArchiveUrl = archives[archives.length - 1]
    const gamesRes = await fetch(lastArchiveUrl)
    if (!gamesRes.ok) throw new Error('Failed to fetch latest games from Chess.com')
    const gamesData = await gamesRes.json()
    const monthGames = gamesData.games || []
    if (!monthGames.length) throw new Error('No games found in the latest archive.')

    return [monthGames[monthGames.length - 1]]
  }

  async function fetchLichessRange(user, yr, mo) {
    const startDate = new Date(Date.UTC(yr, mo - 1, 1)).getTime()
    const endDate = new Date(Date.UTC(yr, mo, 1)).getTime()

    const res = await fetch(`https://lichess.org/api/games/user/${user}?since=${startDate}&until=${endDate}&pgnInJson=true`, {
      headers: { 'Accept': 'application/x-ndjson' }
    })
    if (!res.ok) throw new Error('Failed to fetch from Lichess')

    const text = await res.text()
    if (!text.trim()) return []
    return text.trim().split('\n').map(normalizeLichessLine)
  }

  async function fetchLichessLast(user) {
    const res = await fetch(`https://lichess.org/api/games/user/${user}?max=1&pgnInJson=true`, {
      headers: { 'Accept': 'application/x-ndjson' }
    })
    if (!res.ok) throw new Error('Failed to fetch from Lichess')

    const text = await res.text()
    if (!text.trim()) throw new Error('No games found for this player.')
    return [normalizeLichessLine(text.trim().split('\n')[0])]
  }

  // Build a "game" object out of pasted PGN text, matching the shape
  // selectGame()/analyseGame() expect from Chess.com/Lichess imports.
  function buildGameFromPgn(pgn) {
    const c = new Chess()
    try {
      c.loadPgn(pgn)
    } catch (e) {
      throw new Error('Could not parse that PGN.')
    }
    if (c.history().length === 0) throw new Error('No moves found in that PGN.')

    const headers = c.getHeaders?.() || {}

    return {
      pgn,
      time_class: 'unknown',
      white: {
        username: headers.White || 'White',
        rating: Number(headers.WhiteElo) || 0,
        result: 'unknown'
      },
      black: {
        username: headers.Black || 'Black',
        rating: Number(headers.BlackElo) || 0,
        result: 'unknown'
      }
    }
  }

  function validateFen(fen) {
    const c = new Chess()
    try {
      c.load(fen)
    } catch (e) {
      throw new Error('Could not parse that FEN.')
    }
    return fen
  }

  async function chessImport() {
    loading.value = true
    error.value = null
    games.value = []
    selectedGame.value = null

    try {
      if (importSite.value === 'pgn') {
        if (!pgnText.value.trim()) throw new Error('Paste a PGN first.')
        const game = buildGameFromPgn(pgnText.value.trim())
        games.value = [game]
        selectGame(game)
        loading.value = false
        return
      }

      if (importSite.value === 'fen') {
        if (!fenText.value.trim()) throw new Error('Paste a FEN first.')
        const fen = validateFen(fenText.value.trim())
        // FEN imports skip the game list / selectGame flow entirely and
        // go straight to the analysis page with the position, since
        // there's no move history to review.
        router.push({ path: '/', query: { fen } })
        loading.value = false
        return
      }

      if (!username.value) throw new Error('Enter a username first.')

      if (importMode.value === 'last') {
        games.value = importSite.value === 'chess.com'
          ? await fetchChessComLast(username.value)
          : await fetchLichessLast(username.value)
      } else {
        if (!year.value || month.value === 'month') {
          throw new Error('Pick a year and month.')
        }
        games.value = importSite.value === 'chess.com'
          ? await fetchChessComRange(username.value, year.value, month.value)
          : await fetchLichessRange(username.value, year.value, month.value)
      }

      if (games.value.length === 0) {
        error.value = 'No games found for that search.'
      } else if (importMode.value === 'last') {
        // Only one candidate in "last game" mode — select it straight away
        selectGame(games.value[0])
      }
    } catch (e) {
      error.value = e.message
      console.error(e)
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
    
    const tempChess = new Chess()
    moveslist.value = gameUci.value.map(uci => {
      // Must pass object to modern chess.js to prevent crashes
      const m = tempChess.move({ 
        from: uci.substring(0, 2), 
        to: uci.substring(2, 4), 
        promotion: uci[4] 
      })
      return m ? m.san : uci
    })
  }

  function replayMoves() {
    chess.reset()
    const tempChess = new Chess()
    moveslist.value = reviewMoves.value.map(uci => {
      // Must pass object to modern chess.js to prevent crashes
      const m = tempChess.move({ 
        from: uci.substring(0, 2), 
        to: uci.substring(2, 4), 
        promotion: uci[4] 
      })
      return m ? m.san : uci
    })
  }

  function convertPgnToUci(pgn) {
    if (!pgn) return []
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
    
    let result = '½-½'
    if (me.result === 'win') {
      result = '1-0'
    } else if (['resigned', 'checkmated', 'abandoned', 'lose'].includes(me.result)) {
      result = '0-1'
    }
    
    return {
      opponent: opponent.username,
      result,
      myColor: isWhite ? 'White' : 'Black',
      myRating: me.rating,
      oppRating: opponent.rating
    }
  }

  function analyseGame(){
    if (!selectedGame.value || gameUci.value.length === 0) return
  
    const moveString = gameUci.value.join('-')
  
    router.push({ 
      path: '/', 
      query: { 
        moves: moveString,
        white: selectedGame.value.white.username,
        black: selectedGame.value.black.username,
        whiteRating: selectedGame.value.white.rating,
        blackRating: selectedGame.value.black.rating
      } 
    })
  }
</script>

<template>
  <div class="page-layout">
    <Title/>
    <div class="content-area">
      <div class="import-card">
        <div class="card-header">
          <h1 class="import-title">Import a game</h1>
          <p class="import-subtitle">Pull a game from Chess.com or Lichess, or paste your own PGN/FEN.</p>
        </div>

        <div class="site-toggle">
          <button
            class="site-btn"
            :class="{ active: importSite === 'chess.com' }"
            @click="importSite = 'chess.com'"
          >Chess.com</button>
          <button
            class="site-btn"
            :class="{ active: importSite === 'lichess' }"
            @click="importSite = 'lichess'"
          >Lichess</button>
          <button
            class="site-btn"
            :class="{ active: importSite === 'pgn' }"
            @click="importSite = 'pgn'"
          >PGN</button>
          <button
            class="site-btn"
            :class="{ active: importSite === 'fen' }"
            @click="importSite = 'fen'"
          >FEN</button>
          <button
            class="site-btn"
            :class="{ active: importSite === 'library' }"
            @click="importSite = 'library'"
          >My Library</button>
        </div>

        <!-- Auth Section -->
        <div v-if="importSite === 'library' && !currentUser" class="auth-container">
          <h2 class="auth-title">{{ isRegistering ? 'Create Account' : 'Sign In' }}</h2>
          <p class="auth-desc">Sign in to save and access your games from any device.</p>
          <div class="auth-form">
            <input v-model="authEmail" type="email" placeholder="Email" class="input" />
            <input v-model="authPassword" type="password" placeholder="Password" class="input" />
            <button class="import-btn" @click="handleAuth">
              {{ isRegistering ? 'Register' : 'Login' }}
            </button>
            <p v-if="authError" class="error">{{ authError }}</p>
            <button class="text-btn" @click="isRegistering = !isRegistering">
              {{ isRegistering ? 'Already have an account? Login' : 'Need an account? Register' }}
            </button>
          </div>
        </div>

        <div v-if="importSite === 'library' && currentUser" class="library-container">
          <div class="library-header">
            <span>Logged in as {{ currentUser.email }}</span>
            <button class="logout-btn" @click="handleLogout">Logout</button>
          </div>

          <div v-if="savedGames.length === 0" class="empty-library">
            Your library is empty. Import a game and click "Save to Library".
          </div>
          
          <div v-else class="games-list">
            <div 
              v-for="game in savedGames" 
              :key="game.id" 
              class="game-row" 
              :class="{ selected: selectedGame && selectedGame.id === game.id }" 
              @click="selectGame(game)"
            >
              <span class="color-dot" :class="formatResult(game).myColor.toLowerCase()"></span>
              <span class="opponent">vs {{ formatResult(game).opponent }}</span>
              <span class="rating">{{ formatResult(game).myRating }} vs {{ formatResult(game).oppRating }}</span>
              <span class="result" :class="formatResult(game).result === '1-0' ? 'win' : (formatResult(game).result === '0-1' ? 'loss' : 'draw')">{{ formatResult(game).result }}</span>
              <span class="time-class">{{ game.time_class }}</span>
              <button class="delete-btn" @click="deleteSavedGame(game.id, $event)">×</button>
            </div>
          </div>
        </div>

        <div class="mode-toggle" v-if="!isPasteSource">
          <button
            class="mode-btn"
            :class="{ active: importMode === 'last' }"
            @click="importMode = 'last'"
          >Last game</button>
          <button
            class="mode-btn"
            :class="{ active: importMode === 'range' }"
            @click="importMode = 'range'"
          >By month</button>
        </div>

        <div class="controls" v-if="!isPasteSource">
          <label class="field">
            <span class="field-label">Username</span>
            <input v-model="username" placeholder="e.g. magnuscarlsen" class="input" @keyup.enter="chessImport" />
          </label>

          <template v-if="importMode === 'range'">
            <label class="field field-small">
              <span class="field-label">Year</span>
              <input v-model="year" placeholder="2026" class="input" @keyup.enter="chessImport" />
            </label>

            <label class="field field-small">
              <span class="field-label">Month</span>
              <select v-model="month" class="input">
                <option value="month" disabled>Select</option>
                <option v-for="m in 12" :key="m" :value="m">
                  {{ String(m).padStart(2, '0') }}
                </option>
              </select>
            </label>
          </template>

          <button class="import-btn" @click="chessImport" :disabled="loading">
            <span v-if="loading" class="spinner"></span>
            {{ loading ? 'Fetching…' : (importMode === 'last' ? 'Get last game' : 'Search games') }}
          </button>
        </div>

        <div class="paste-controls" v-if="importSite === 'pgn'">
          <label class="field">
            <span class="field-label">PGN</span>
            <textarea
              v-model="pgnText"
              class="input textarea"
              rows="6"
              placeholder="[Event &quot;Casual Game&quot;]&#10;1. e4 e5 2. Nf3 Nc6 3. Bb5 ..."
            ></textarea>
          </label>
          <button class="import-btn" @click="chessImport" :disabled="loading">
            <span v-if="loading" class="spinner"></span>
            {{ loading ? 'Parsing…' : 'Load PGN' }}
          </button>
        </div>

        <div class="paste-controls" v-if="importSite === 'fen'">
          <label class="field">
            <span class="field-label">FEN</span>
            <textarea
              v-model="fenText"
              class="input textarea textarea-fen"
              rows="2"
              placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
            ></textarea>
          </label>
          <button class="import-btn" @click="chessImport" :disabled="loading">
            <span v-if="loading" class="spinner"></span>
            {{ loading ? 'Loading…' : 'Load FEN' }}
          </button>
        </div>

        <div v-if="error" class="error">{{ error }}</div>

        <div v-if="games.length > 1" class="games-list">
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
            <span class="result" :class="formatResult(game).result === '1-0' ? 'win' : (formatResult(game).result === '0-1' ? 'loss' : 'draw')">{{ formatResult(game).result }}</span>
            <span class="time-class">{{ game.time_class }}</span>
          </div>
        </div>
        
        <div v-if="selectedGame && importSite !== 'fen'" class="selection-bar">
          <div class="selection-info">
            <span class="selected-msg">Game ready</span>
            <span class="selection-players">
              {{ selectedGame.white.username }} ({{ selectedGame.white.rating }}) vs {{ selectedGame.black.username }} ({{ selectedGame.black.rating }})
            </span>
          </div>
          <button class="analyse-btn" @click="analyseGame()">Analyse →</button>
          <button v-if="currentUser && importSite !== 'library'" class="save-btn" @click="saveCurrentGame" title="Save to Library">
            💾
          </button>
        </div>
        <div v-else-if="games.length && !loading && importSite !== 'fen'" class="empty">
          No game selected yet.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');

  .page-layout {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    padding: clamp(0.5rem, 3vw, 1rem);
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.25rem;
    justify-self: center;
    max-width: 1200px;
    margin: 0 auto;
    box-sizing: border-box;
  }

  @media (min-width: 768px) {
    .page-layout {
      grid-template-columns: auto 1fr;
      gap: 1.5rem;
    }
  }

  .content-area {
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
  }

  .import-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: clamp(1.25rem, 3vw, 1.75rem);
    width: 100%;
    max-width: 30rem;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .card-header { text-align: center; }

  .import-title {
    font-family: serif;
    color: #f5f5dc;
    font-weight: 700;
    text-transform: uppercase;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
    letter-spacing: 2px;
    font-size: clamp(1.3rem, 3vw, 1.7rem);
    margin: 0 0 0.4rem;
  }

  .import-subtitle {
    color: rgba(244, 240, 227, 0.72);
    font-size: 0.85rem;
    margin: 0;
  }

  .site-toggle, .mode-toggle {
    display: flex;
    gap: 0.5rem;
    background: rgba(0, 0, 0, 0.2);
    padding: 0.3rem;
    border-radius: 10px;
  }

  .site-btn, .mode-btn {
    flex: 1;
    padding: 0.5rem 0.6rem;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgba(244, 240, 227, 0.65);
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .site-btn:hover, .mode-btn:hover { color: #f4f0e3; }

  .site-btn.active, .mode-btn.active {
    background: var(--btn-active);
    color: #f5f5dc;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
  }

  .controls {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    align-items: flex-end;
  }

  .paste-controls {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .textarea {
    resize: vertical;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.82rem;
    line-height: 1.4;
  }

  .textarea-fen {
    resize: none;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: 1 1 10rem;
    min-width: 0;
  }

  .field-small { flex: 1 1 5rem; }

  .field-label {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: rgba(244, 240, 227, 0.65);
  }

  .input {
    padding: 0.55rem 0.7rem;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.25);
    color: #f4f0e3;
    font-size: 0.9rem;
    box-sizing: border-box;
    width: 100%;
  }

  .input:focus {
    outline: none;
    border-color: var(--text-highlight);
    box-shadow: 0 0 0 2px rgba(217, 179, 130, 0.2);
  }

  .import-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.6rem 1.1rem;
    border-radius: 8px;
    background: var(--btn-active);
    color: #f4f0e3;
    border: none;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.2s ease;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .import-btn:hover:not(:disabled) { background: var(--btn-idle); }
  .import-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .spinner {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 50%;
    border: 2px solid rgba(244, 240, 227, 0.35);
    border-top-color: #f4f0e3;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .error {
    color: #ffb0a8;
    background: rgba(255, 60, 60, 0.12);
    border: 1px solid rgba(255, 100, 90, 0.3);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    font-size: 0.85rem;
  }

  .games-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 300px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: rgba(194, 197, 170, 0.4) rgba(0, 0, 0, 0.2);
    width: 100%;
    box-sizing: border-box;
  }

  .game-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.55rem 0.75rem;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
    color: #f4f0e3;
  }

  .game-row:hover { background: rgba(0, 0, 0, 0.3); }

  .game-row.selected {
    background: rgba(255, 255, 255, 0.08);
    border-color: var(--text-highlight);
  }

  .color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
  }

  .color-dot.white { background: #f4f0e3; }
  .color-dot.black { background: #1a1a1a; }

  .opponent {
    flex: 1;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rating {
    font-family: "JetBrains Mono", monospace;
    color: rgba(244, 240, 227, 0.6);
    font-size: 0.8rem;
    flex-shrink: 0;
  }

  .time-class {
    color: rgba(244, 240, 227, 0.55);
    font-size: 0.78rem;
    text-transform: capitalize;
    flex-shrink: 0;
  }

  .result {
    font-weight: 700;
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  /* Win/loss/draw keep dedicated semantic colors (not theme-tinted), softened
     from the previous bright green/red so they don't clash with muted themes. */
  .result.win { color: #8fc06a; }
  .result.loss { color: #d9736a; }
  .result.draw { color: #d9b36a; }

  .selection-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 0.9rem;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    border: 1px solid var(--text-highlight);
  }

  .selection-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .selected-msg {
    color: var(--text-highlight);
    font-weight: 700;
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .selection-players {
    color: #f4f0e3;
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .analyse-btn {
    padding: 0.5rem 1.1rem;
    border-radius: 8px;
    font-weight: 700;
    color: #f4f0e3;
    background: var(--btn-active);
    border: none;
    cursor: pointer;
    transition: background 0.2s ease;
    flex-shrink: 0;
  }

  .analyse-btn:hover { background: var(--btn-idle); }

  /* Auth & Library Styles */
  .auth-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.15);
    border-radius: 12px;
    text-align: center;
  }

  .auth-title {
    font-family: serif;
    font-size: 1.25rem;
    color: var(--text-highlight);
  }

  .auth-desc {
    font-size: 0.85rem;
    color: rgba(244, 240, 227, 0.7);
    margin-bottom: 0.5rem;
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .text-btn {
    background: none;
    border: none;
    color: var(--text-highlight);
    font-size: 0.8rem;
    cursor: pointer;
    text-decoration: underline;
    opacity: 0.8;
  }

  .text-btn:hover { opacity: 1; }

  .library-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .library-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
    color: rgba(244, 240, 227, 0.8);
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
  }

  .logout-btn {
    background: rgba(255, 100, 100, 0.15);
    border: 1px solid rgba(255, 100, 100, 0.3);
    color: #ffb0a8;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .logout-btn:hover { background: rgba(255, 100, 100, 0.25); }

  .empty-library {
    text-align: center;
    padding: 2rem;
    color: rgba(244, 240, 227, 0.5);
    font-style: italic;
    background: rgba(0, 0, 0, 0.1);
    border-radius: 8px;
  }

  .delete-btn {
    background: none;
    border: none;
    color: rgba(255, 100, 100, 0.5);
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0 0.5rem;
    margin-left: auto;
    transition: color 0.2s;
  }

  .delete-btn:hover { color: #ffb0a8; }

  .save-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    padding: 0.5rem;
    font-size: 1.1rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .save-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    transform: scale(1.05);
  }

  .empty {
    color: rgba(244, 240, 227, 0.6);
    text-align: center;
    padding: 0.7rem;
    background: rgba(0, 0, 0, 0.15);
    border-radius: 8px;
    font-size: 0.85rem;
  }
</style>