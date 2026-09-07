<script setup>
  import { ref, computed, watch, onMounted } from 'vue'
  import Title from '../assets/Title.vue'
  import { Chess } from 'chess.js'
  import { useRouter } from 'vue-router'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { 
    collection, addDoc, query, where, getDocs, serverTimestamp,
    deleteDoc, doc, orderBy
  } from 'firebase/firestore'

  const router = useRouter()
  const USERNAME_STORAGE_KEY = 'chesslab_username'
  const username = ref(localStorage.getItem(USERNAME_STORAGE_KEY) || '')

  // --- Apply theme instantly on script load to prevent refresh flashing ---
  const currentTheme = ref(localStorage.getItem('chesslab_theme') || 'brown')
  watch(currentTheme, (newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('chesslab_theme', newTheme)
  }, { immediate: true })

  watch(username, (val) => localStorage.setItem(USERNAME_STORAGE_KEY, val))

  const year = ref('')
  const month = ref('month')
  const games = ref([])
  const selectedGame = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const info = ref(null) // non-error notes (e.g. Chess.com archive lag)
  const gameUci = ref([])
  const reviewMoves = ref([])
  const reviewIndex = ref(0)
  const moveslist = ref([])
  const chess = new Chess()
  const importSite = ref('chess.com')
  const importMode = ref('last')

  const currentUser = ref(null)
  const savedGames = ref([])
  const saveStatus = ref('')

  // --- Browsing / filtering state (shared by fetched games + library) ---
  const tcFilter = ref('all')
  const opponentSearch = ref('')
  watch(importSite, () => {
    tcFilter.value = 'all'
    opponentSearch.value = ''
  })

  const monthNames = Array.from({ length: 12 }, (_, i) => {
    return new Date(2000, i, 1).toLocaleString('default', { month: 'long' })
  })
  const yearOptions = Array.from({ length: 11 }, (_, i) => new Date().getFullYear() - i)

  onMounted(() => {
    onAuthStateChanged(auth, (user) => {
      currentUser.value = user
      if (user) fetchSavedGames()
      else savedGames.value = []
    })
  })

  // --- Time control normalization (Chess.com + Lichess use different names) ---
  const TC_ORDER = ['ultrabullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'daily', 'unknown']
  const TC_LABELS = {
    ultrabullet: 'UltraBullet',
    bullet: 'Bullet',
    blitz: 'Blitz',
    rapid: 'Rapid',
    classical: 'Classical',
    correspondence: 'Correspondence',
    daily: 'Daily',
    unknown: 'Other'
  }
  const tcKey = (g) => (g?.time_class || 'unknown').toLowerCase()

  // The list currently being browsed (library tab vs fetched results)
  const activeSource = computed(() => importSite.value === 'library' ? savedGames.value : games.value)

  const tcCounts = computed(() => {
    const counts = new Map()
    for (const g of activeSource.value) {
      counts.set(tcKey(g), (counts.get(tcKey(g)) || 0) + 1)
    }
    return counts
  })

  const timeControlTabs = computed(() => {
    const tabs = [{ value: 'all', label: 'All', count: activeSource.value.length }]
    for (const tc of TC_ORDER) {
      if (tcCounts.value.has(tc)) {
        tabs.push({ value: tc, label: TC_LABELS[tc] || tc, count: tcCounts.value.get(tc) })
      }
    }
    return tabs
  })

  const filteredGames = computed(() => {
    let list = activeSource.value
    if (tcFilter.value !== 'all') list = list.filter(g => tcKey(g) === tcFilter.value)
    const q = opponentSearch.value.trim().toLowerCase()
    if (q) {
      list = list.filter(g =>
        (g.white?.username || '').toLowerCase().includes(q) ||
        (g.black?.username || '').toLowerCase().includes(q)
      )
    }
    return list
  })

  const overallStats = computed(() => statsFor(filteredGames.value))

  const displayedGroups = computed(() => {
    const keys = tcFilter.value === 'all'
      ? TC_ORDER.filter(k => tcCounts.value.has(k))
      : [tcFilter.value]
    return keys
      .map(key => {
        const groupGames = filteredGames.value
          .filter(g => tcKey(g) === key)
          .sort((a, b) => sortValue(b) - sortValue(a))
        return { key, label: TC_LABELS[key] || key, games: groupGames, stats: statsFor(groupGames) }
      })
      .filter(g => g.games.length > 0)
  })

  function sortValue(g) {
    const d = g.date ? g.date.getTime() : 0
    return d || g.savedAt || 0
  }

  function statsFor(list) {
    const s = { w: 0, l: 0, d: 0 }
    for (const g of list) {
      const o = formatResult(g).outcome
      if (o === 'win') s.w++
      else if (o === 'loss') s.l++
      else s.d++
    }
    return s
  }

  async function fetchSavedGames() {
    if (!currentUser.value) return
    try {
      const q = query(
        collection(db, `users/${currentUser.value.uid}/games`),
        orderBy('createdAt', 'desc')
      )
      const querySnapshot = await getDocs(q)
      savedGames.value = querySnapshot.docs.map(d => {
        const data = d.data()
        return {
          id: d.id,
          pgn: data.pgn || "",
          time_class: data.time_class || "unknown",
          savedAt: data.createdAt?.toMillis?.() || 0,
          date: typeof data.playedAt === 'number' ? new Date(data.playedAt) : null,
          white: {
            username: data.white?.username || "White",
            rating: data.white?.rating || 0,
            result: data.white?.result || "unknown"
          },
          black: {
            username: data.black?.username || "Black",
            rating: data.black?.rating || 0,
            result: data.black?.result || "unknown"
          }
        }
      })
    } catch (e) {
      console.error("Failed to fetch saved games:", e)
      savedGames.value = []
    }
  }

  function generatePgnHash(pgn) {
    let hash = 0
    for (let i = 0; i < pgn.length; i++) {
      const char = pgn.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash &= hash
    }
    return String(hash)
  }

  async function autoSaveGame() {
    if (!currentUser.value || !selectedGame.value) return
    try {
      const gamesRef = collection(db, `users/${currentUser.value.uid}/games`)
      const pgnHash = generatePgnHash(selectedGame.value.pgn)

      const dupQ = query(gamesRef, where('pgnHash', '==', pgnHash))
      const dupSnap = await getDocs(dupQ)
      if (!dupSnap.empty) return

      await addDoc(gamesRef, {
        pgn: selectedGame.value.pgn,
        pgnHash: pgnHash,
        white: selectedGame.value.white,
        black: selectedGame.value.black,
        time_class: selectedGame.value.time_class,
        playedAt: selectedGame.value.date ? selectedGame.value.date.getTime() : null,
        createdAt: serverTimestamp()
      })
      await fetchSavedGames()
    } catch (e) {
      console.error('Auto-save failed:', e)
      saveStatus.value = 'Failed to save game.'
      setTimeout(() => saveStatus.value = '', 2500)
    }
  }

  async function deleteSavedGame(gameId, event) {
    if (event) event.stopPropagation()
    if (!confirm('Delete this game?')) return
    try {
      await deleteDoc(doc(db, `users/${currentUser.value.uid}/games`, gameId))
      savedGames.value = savedGames.value.filter(g => g.id !== gameId)
      if (selectedGame.value?.id === gameId) selectedGame.value = null
    } catch (e) { console.error(e) }
  }

  const pgnText = ref('')
  const fenText = ref('')
  const isPasteSource = computed(() =>
    importSite.value === 'pgn' || importSite.value === 'fen' || importSite.value === 'library'
  )

  // --- Helper to clean PGNs before chess.js parses them ---
  function cleanPgn(pgn) {
    if (!pgn) return ''
    let cleaned = pgn
      .replace(/\{[^}]*\}/g, ' ')   // Remove comments
      .replace(/\$\d+/g, ' ')        // Remove NAGs
      .replace(/\s*e\.p\.\s*/g, ' ') // Remove en passant annotations

    // Remove nested variations
    let prev
    do {
      prev = cleaned
      cleaned = cleaned.replace(/\([^()]*\)/g, ' ')
    } while (cleaned !== prev)

    // Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    return cleaned
  }

  function normalizeChessCom(g) {
    return {
      pgn: cleanPgn(g.pgn || ''),
      time_class: g.time_class || 'unknown',
      date: g.end_time ? new Date(g.end_time * 1000) : null,
      white: { username: g.white?.username || 'White', rating: g.white?.rating || 0, result: g.white?.result || 'unknown' },
      black: { username: g.black?.username || 'Black', rating: g.black?.rating || 0, result: g.black?.result || 'unknown' }
    }
  }

  function normalizeLichess(line) {
    const lGame = JSON.parse(line)
    let wRes = 'draw', bRes = 'draw'
    if (lGame.winner === 'white') { wRes = 'win'; bRes = 'lose' }
    else if (lGame.winner === 'black') { wRes = 'lose'; bRes = 'win' }
    const ts = lGame.lastMoveAt || lGame.createdAt
    return {
      pgn: cleanPgn(lGame.pgn || ""),
      time_class: lGame.speed || "unknown",
      date: ts ? new Date(ts) : null,
      white: { username: lGame.players?.white?.user?.name || "Anonymous", rating: lGame.players?.white?.rating || 0, result: wRes },
      black: { username: lGame.players?.black?.user?.name || "Anonymous", rating: lGame.players?.black?.rating || 0, result: bRes }
    }
  }

  // ---------------------------------------------------------------------
  // Chess.com fetching, with freshness fixes:
  //  1. `cache: 'no-store'` — never serve the response from the browser cache.
  //  2. `?t=<timestamp>`  — bust Chess.com's CDN cache (each request is a
  //     unique URL). Chess.com ignores unknown query params, so this is safe.
  //     (Lichess rejects unknown params, so we do NOT add it there.)
  //  3. "Last game" fetches the CURRENT month directly instead of trusting
  //     the CDN-cached archives list, which can lag behind.
  // ---------------------------------------------------------------------
  function bust(url) {
    return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
  }

  async function fetchChessComJson(url) {
    const res = await fetch(bust(url), { cache: 'no-store' })
    if (!res.ok) throw new Error(`Chess.com request failed (${res.status})`)
    return res.json()
  }

  async function fetchChessComRange(user, yr, mo) {
    const paddedMonth = String(mo).padStart(2, '0')
    const data = await fetchChessComJson(`https://api.chess.com/pub/player/${user}/games/${yr}/${paddedMonth}`)
    return (data.games || []).map(normalizeChessCom)
  }

  async function fetchChessComLast(user) {
    // Chess.com files games by UTC month, so work in UTC.
    const now = new Date()
    let y = now.getUTCFullYear()
    let m = now.getUTCMonth() + 1

    // Try the current month, then the previous month (covers the start of a
    // new UTC month, and the 404s/empty months when a player hasn't played).
    const candidates = [[y, m]]
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
    candidates.push([y, m])

    for (const [yy, mm] of candidates) {
      try {
        const monthGames = await fetchChessComRange(user, yy, mm)
        if (monthGames.length) return [monthGames[monthGames.length - 1]]
      } catch (e) {
        // Month may not exist / no games — try the next candidate.
      }
    }

    // Last resort: no games in the last ~2 months, use the archives list.
    const data = await fetchChessComJson(`https://api.chess.com/pub/player/${user}/games/archives`)
    const archives = data.archives || []
    if (!archives.length) throw new Error('No games found for this player.')
    const lastData = await fetchChessComJson(archives[archives.length - 1])
    const monthGames = (lastData.games || []).map(normalizeChessCom)
    if (!monthGames.length) throw new Error('No games found in the latest archive.')
    return [monthGames[monthGames.length - 1]]
  }

  async function fetchLichessRange(user, yr, mo) {
    const startDate = new Date(Date.UTC(yr, mo - 1, 1)).getTime()
    const endDate = new Date(Date.UTC(yr, mo, 1)).getTime()
    const res = await fetch(`https://lichess.org/api/games/user/${user}?since=${startDate}&until=${endDate}&pgnInJson=true`, {
      headers: { 'Accept': 'application/x-ndjson' },
      cache: 'no-store'
    })
    if (!res.ok) throw new Error('Failed to fetch from Lichess')
    const text = await res.text()
    if (!text.trim()) return []
    return text.trim().split('\n').map(normalizeLichess)
  }

  async function fetchLichessLast(user) {
    const res = await fetch(`https://lichess.org/api/games/user/${user}?max=1&pgnInJson=true`, {
      headers: { 'Accept': 'application/x-ndjson' },
      cache: 'no-store'
    })
    if (!res.ok) throw new Error('Failed to fetch from Lichess')
    const text = await res.text()
    if (!text.trim()) throw new Error('No games found for this player.')
    return [normalizeLichess(text.trim().split('\n')[0])]
  }

  function buildGameFromPgn(pgn) {
    const c = new Chess()
    const cleanedPgn = cleanPgn(pgn)

    // Helper to extract headers manually if standard parsing fails
    const extractHeader = (key) => {
      const match = new RegExp(`\\[${key} "(.*?)"\\]`).exec(pgn)
      return match ? match[1] : ''
    }

    let parsedSuccessfully = false
    try {
      c.loadPgn(cleanedPgn)
      if (c.history().length > 0) parsedSuccessfully = true
    } catch (e) {
      console.warn("Standard loadPgn failed, attempting fallback recovery...", e.message)
    }

    if (parsedSuccessfully) {
      const headers = c.getHeaders?.() || {}
      const whiteName = headers.White || extractHeader('White') || 'White'
      const blackName = headers.Black || extractHeader('Black') || 'Black'
      const whiteElo = headers.WhiteElo || extractHeader('WhiteElo')
      const blackElo = headers.BlackElo || extractHeader('BlackElo')
      const result = headers.Result || extractHeader('Result') || '*'

      return {
        pgn: cleanedPgn,
        time_class: 'unknown',
        date: null,
        white: { username: whiteName, rating: Number(whiteElo) || 0, result: result === '1-0' ? 'win' : (result === '0-1' ? 'lose' : 'draw') },
        black: { username: blackName, rating: Number(blackElo) || 0, result: result === '0-1' ? 'win' : (result === '1-0' ? 'lose' : 'draw') }
      }
    }

    // Fallback parser for malformed PGNs (e.g. missing half-moves)
    c.reset()
    const movesStr = cleanedPgn.replace(/\[.*?\]/gs, '').replace(/\d+\.(\.\.)?/g, ' ').replace(/(1-0|0-1|1\/2-1\/2|\*)/g, '').trim()
    const moves = movesStr.split(/\s+/).filter(m => m.length > 0)

    let validMovesApplied = 0
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i]
      if (!move) continue
      try {
        c.move(move)
        validMovesApplied++
      } catch (err) {
        // Toggle turn to see if a move was skipped
        const fenParts = c.fen().split(' ')
        fenParts[1] = fenParts[1] === 'w' ? 'b' : 'w'
        fenParts[3] = '-' // Remove en passant target square
        const newFen = fenParts.join(' ')

        try {
          const tempBoard = new Chess(newFen)
          tempBoard.move(move)
          // It worked! Apply it to the main board
          c.load(newFen)
          c.move(move)
          validMovesApplied++
        } catch (err2) {
          console.error(`Skipped unrecoverable invalid move: ${move}`)
          break
        }
      }
    }

    if (validMovesApplied === 0) throw new Error('No valid moves found in that PGN. Please check the format.')

    const whiteName = extractHeader('White') || 'White'
    const blackName = extractHeader('Black') || 'Black'
    const whiteElo = extractHeader('WhiteElo')
    const blackElo = extractHeader('BlackElo')
    const result = extractHeader('Result') || '*'

    // Generate a clean PGN from the successfully parsed moves
    const cleanMovesPgn = c.pgn()
    const headerStr = `[White "${whiteName}"]\n[Black "${blackName}"]\n[Result "${result}"]${whiteElo ? `\n[WhiteElo "${whiteElo}"]` : ''}${blackElo ? `\n[BlackElo "${blackElo}"]` : ''}`
    const finalPgn = `${headerStr}\n\n${cleanMovesPgn} ${result}`.trim()

    return {
      pgn: finalPgn,
      time_class: 'unknown',
      date: null,
      white: { username: whiteName, rating: Number(whiteElo) || 0, result: result === '1-0' ? 'win' : (result === '0-1' ? 'lose' : 'draw') },
      black: { username: blackName, rating: Number(blackElo) || 0, result: result === '0-1' ? 'win' : (result === '1-0' ? 'lose' : 'draw') }
    }
  }

  function validateFen(fen) {
    const c = new Chess()
    try { c.load(fen) } catch (e) { throw new Error('Could not parse that FEN.') }
    return fen
  }

  async function chessImport() {
    loading.value = true
    error.value = null
    info.value = null
    games.value = []
    selectedGame.value = null
    tcFilter.value = 'all'
    opponentSearch.value = ''
    try {
      if (importSite.value === 'pgn') {
        if (!pgnText.value.trim()) throw new Error('Paste a PGN first.')
        const game = buildGameFromPgn(pgnText.value.trim())
        games.value = [game]
        selectGame(game)
        return
      }
      if (importSite.value === 'fen') {
        if (!fenText.value.trim()) throw new Error('Paste a FEN first.')
        const fen = validateFen(fenText.value.trim())
        router.push({ path: '/', query: { fen } })
        return
      }
      if (!username.value) throw new Error('Enter a username first.')

      if (importMode.value === 'last') {
        const lastGames = importSite.value === 'chess.com'
          ? await fetchChessComLast(username.value)
          : await fetchLichessLast(username.value)
        games.value = lastGames

        // Chess.com can take a few minutes to publish a just-finished game.
        // If the newest published game is older than ~5 minutes, say so
        // instead of silently looking broken.
        if (importSite.value === 'chess.com') {
          const lastDate = lastGames[0]?.date
          const ageMin = lastDate ? (Date.now() - lastDate.getTime()) / 60000 : Infinity
          if (ageMin > 5) {
            info.value = 'Showing your most recent published game. Chess.com can takes some time to publish brand-new games — if yours is missing, you can paste the pgn of the game in the pgn tab.'
          }
        }

        if (lastGames.length) selectGame(lastGames[0])
      } else {
        if (!year.value || month.value === 'month') throw new Error('Pick a year and month.')
        const fetched = importSite.value === 'chess.com'
          ? await fetchChessComRange(username.value, year.value, month.value)
          : await fetchLichessRange(username.value, year.value, month.value)
        // Both APIs return oldest-first; show newest first instead.
        games.value = [...fetched].sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
      }

      if (games.value.length === 0) {
        error.value = 'No games found for that search.'
      }
    } catch (e) {
      error.value = e.message
      console.error(e)
    } finally {
      loading.value = false
    }
  }

  function isSelected(game) {
    if (!selectedGame.value) return false
    if (selectedGame.value === game) return true
    return !!game.id && selectedGame.value.id === game.id
  }

  function selectGame(game) {
    // Ensure the PGN is cleaned before processing to avoid chess.js errors
    if (game && game.pgn) {
      game.pgn = cleanPgn(game.pgn)
    }

    selectedGame.value = game
    gameUci.value = convertPgnToUci(game.pgn)
    reviewMoves.value = gameUci.value
    reviewIndex.value = 0
    chess.reset()

    const tempChess = new Chess()
    moveslist.value = gameUci.value.map(uci => {
      const m = tempChess.move({ from: uci.substring(0, 2), to: uci.substring(2, 4), promotion: uci[4] })
      return m ? m.san : uci
    })
  }

  function convertPgnToUci(pgn) {
    const cleanedPgn = cleanPgn(pgn)
    if (!cleanedPgn) return []
    const c = new Chess()
    try {
      c.loadPgn(cleanedPgn)
    } catch (e) {
      console.error('convertPgnToUci PGN parse error:', e)
      return []
    }
    return c.history({ verbose: true }).map(move => {
      let uci = move.from + move.to
      if (move.promotion) uci += move.promotion
      return uci
    })
  }

  function formatDate(game) {
    if (!game?.date || isNaN(game.date.getTime())) return ''
    const d = game.date
    const sameYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString(undefined, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: '2-digit' })
  }

  // Chess.com result strings that mean the player LOST (timeout was missing
  // before, so losses on time were displayed as draws).
  const LOSS_RESULTS = ['resigned', 'checkmated', 'abandoned', 'lose', 'timeout', 'kingofthehill', 'threecheck', 'bughousepartnerlose']

  function formatResult(game) {
    const myUsername = (username.value || '').trim().toLowerCase()
    const whiteUsername = (game.white?.username || '').toLowerCase()
    const blackUsername = (game.black?.username || '').toLowerCase()

    // Only trust the color match if the username actually matches a player;
    // otherwise default to White's perspective.
    const matched = myUsername && (whiteUsername === myUsername || blackUsername === myUsername)
    const isWhite = matched ? whiteUsername === myUsername : true

    const me = isWhite ? (game.white || {}) : (game.black || {})
    const opponent = isWhite ? (game.black || {}) : (game.white || {})

    let result = '½-½'
    let outcome = 'draw'
    if (me.result === 'win') {
      result = isWhite ? '1-0' : '0-1'
      outcome = 'win'
    } else if (LOSS_RESULTS.includes(me.result)) {
      result = isWhite ? '0-1' : '1-0'
      outcome = 'loss'
    }

    return {
      opponent: opponent.username || 'Unknown',
      result,
      outcome,
      myColor: isWhite ? 'White' : 'Black',
      myRating: me.rating || 0,
      oppRating: opponent.rating || 0
    }
  }

  async function analyseGame() {
    if (!selectedGame.value || gameUci.value.length === 0) return

    if (currentUser.value) {
      saveStatus.value = 'Saving to library…'
      await autoSaveGame()
      saveStatus.value = 'Saved to library ✓'
      setTimeout(() => saveStatus.value = '', 2500)
    }

    const moveString = gameUci.value.join('-')

    // Determine the user's actual color by matching usernames
    const myUsername = (username.value || '').trim().toLowerCase()
    const whiteUsername = (selectedGame.value.white?.username || '').toLowerCase()
    const blackUsername = (selectedGame.value.black?.username || '').toLowerCase()
    const matched = myUsername && (whiteUsername === myUsername || blackUsername === myUsername)
    const myColor = matched ? (whiteUsername === myUsername ? 'white' : 'black') : 'white'

    router.push({
      path: '/',
      query: {
        moves: moveString,
        white: selectedGame.value.white.username,
        black: selectedGame.value.black.username,
        whiteRating: selectedGame.value.white.rating,
        blackRating: selectedGame.value.black.rating,
        pgn: selectedGame.value.pgn,
        myColor
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
          <p class="import-subtitle">Pull a game from Chess.com or Lichess, paste PGN/FEN, or browse your library.</p>
        </div>

        <div class="site-toggle">
          <button class="site-btn" :class="{ active: importSite === 'chess.com' }" @click="importSite = 'chess.com'">Chess.com</button>
          <button class="site-btn" :class="{ active: importSite === 'lichess' }" @click="importSite = 'lichess'">Lichess</button>
          <button class="site-btn" :class="{ active: importSite === 'pgn' }" @click="importSite = 'pgn'">PGN</button>
          <button class="site-btn" :class="{ active: importSite === 'fen' }" @click="importSite = 'fen'">FEN</button>
          <button class="site-btn" :class="{ active: importSite === 'library' }" @click="importSite = 'library'">My Library</button>
        </div>

        <div v-if="importSite === 'library' && !currentUser" class="empty-library">
          Please log in from the top right corner to access your saved games.
        </div>
        <div v-else-if="importSite === 'library' && savedGames.length === 0" class="empty-library">
          Your library is empty. Analyze a game and it will be saved here automatically.
        </div>

        <div class="mode-toggle" v-if="!isPasteSource">
          <button class="mode-btn" :class="{ active: importMode === 'last' }" @click="importMode = 'last'">Last game</button>
          <button class="mode-btn" :class="{ active: importMode === 'range' }" @click="importMode = 'range'">By month</button>
        </div>

        <div class="controls" v-if="!isPasteSource">
          <label class="field">
            <span class="field-label">Username</span>
            <input v-model="username" placeholder="e.g. magnuscarlsen" class="input" @keyup.enter="chessImport" />
          </label>
          <template v-if="importMode === 'range'">
            <label class="field field-small">
              <span class="field-label">Year</span>
              <div class="select-wrapper">
                <select v-model="year" class="input select-input">
                  <option value="" disabled>Select Year</option>
                  <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
                </select>
                <svg class="dropdown-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </label>
            <label class="field field-small">
              <span class="field-label">Month</span>
              <div class="select-wrapper">
                <select v-model="month" class="input select-input">
                  <option value="month" disabled>Select Month</option>
                  <option v-for="(name, i) in monthNames" :key="i" :value="i + 1">{{ name }}</option>
                </select>
                <svg class="dropdown-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
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
            <textarea v-model="pgnText" class="input textarea" rows="6" placeholder='[Event "Casual Game"]&#10;1. e4 e5 2. Nf3 Nc6 3. Bb5 ...'></textarea>
          </label>
          <button class="import-btn" @click="chessImport" :disabled="loading">
            <span v-if="loading" class="spinner"></span>
            {{ loading ? 'Parsing…' : 'Load PGN' }}
          </button>
        </div>

        <div class="paste-controls" v-if="importSite === 'fen'">
          <label class="field">
            <span class="field-label">FEN</span>
            <textarea v-model="fenText" class="input textarea textarea-fen" rows="2" placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"></textarea>
          </label>
          <button class="import-btn" @click="chessImport" :disabled="loading">
            <span v-if="loading" class="spinner"></span>
            {{ loading ? 'Loading…' : 'Load FEN' }}
          </button>
        </div>

        <div v-if="error" class="error">{{ error }}</div>
        <div v-if="info" class="info-note">{{ info }}</div>
        <div v-if="saveStatus" class="save-toast">{{ saveStatus }}</div>

        <!-- Results browser: shared by fetched games and My Library -->
        <div v-if="activeSource.length" class="results">
          <div class="results-meta">
            <span class="results-count">
              <template v-if="activeSource.length > 1">{{ filteredGames.length }} of {{ activeSource.length }} games</template>
              <template v-else>1 game</template>
            </span>
            <span class="results-record">
              <span class="rec-w">{{ overallStats.w }}W</span>
              <span class="rec-l">{{ overallStats.l }}L</span>
              <span class="rec-d">{{ overallStats.d }}D</span>
            </span>
          </div>

          <div class="results-toolbar" v-if="activeSource.length > 1">
            <div class="tc-chips">
              <button
                v-for="tab in timeControlTabs"
                :key="tab.value"
                class="tc-chip"
                :class="[tab.value, { active: tcFilter === tab.value }]"
                @click="tcFilter = tab.value"
              >
                {{ tab.label }}<span class="chip-count">{{ tab.count }}</span>
              </button>
            </div>
            <input v-model="opponentSearch" class="input search-input" placeholder="Filter by player…" />
          </div>

          <div class="games-list">
            <section v-for="group in displayedGroups" :key="group.key" class="tc-group">
              <header class="tc-group-header">
                <span class="tc-badge" :class="group.key"></span>
                <span class="tc-name">{{ group.label }}</span>
                <span class="tc-stats">
                  {{ group.games.length }} {{ group.games.length === 1 ? 'game' : 'games' }} ·
                  <span class="rec-w">{{ group.stats.w }}W</span>
                  <span class="rec-l">{{ group.stats.l }}L</span>
                  <span class="rec-d">{{ group.stats.d }}D</span>
                </span>
              </header>
              <div
                v-for="(game, i) in group.games"
                :key="group.key + '-' + i"
                class="game-row"
                :class="{ selected: isSelected(game) }"
                @click="selectGame(game)"
              >
                <span class="color-dot" :class="formatResult(game).myColor.toLowerCase()"></span>
                <span class="opponent">vs {{ formatResult(game).opponent }}</span>
                <span v-if="formatDate(game)" class="date">{{ formatDate(game) }}</span>
                <span class="rating">{{ formatResult(game).myRating }} vs {{ formatResult(game).oppRating }}</span>
                <span class="result" :class="formatResult(game).outcome">{{ formatResult(game).result }}</span>
                <button v-if="game.id" class="delete-btn" @click="deleteSavedGame(game.id, $event)">×</button>
              </div>
            </section>
          </div>

          <div v-if="filteredGames.length === 0" class="empty">No games match your filters.</div>
        </div>

        <div v-if="selectedGame && importSite !== 'fen'" class="selection-bar">
          <div class="selection-info">
            <span class="selected-msg">Game ready</span>
            <span class="selection-players">
              {{ selectedGame.white.username }} ({{ selectedGame.white.rating }})
              vs {{ selectedGame.black.username }} ({{ selectedGame.black.rating }})
              <template v-if="formatDate(selectedGame)"> · {{ formatDate(selectedGame) }}</template>
            </span>
          </div>
          <button class="analyse-btn" @click="analyseGame()">Analyse →</button>
        </div>
        <div v-else-if="activeSource.length > 1 && !loading && importSite !== 'fen'" class="empty">
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
    min-width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }

  @media (min-width: 768px) {
    .page-layout { grid-template-columns: auto 1fr; gap: 1.5rem; }
  }

  .content-area { display: flex; justify-content: stretch; width: 100%; min-width: 0; }

  .import-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: clamp(1.25rem, 3vw, 2rem);
    width: 100%;
    max-width: 100%;
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

  .import-subtitle { color: rgba(244, 240, 227, 0.72); font-size: 0.85rem; margin: 0; }

  .site-toggle, .mode-toggle {
      display: flex;
      flex-wrap: wrap;         
      gap: 0.4rem;
      background: rgba(0, 0, 0, 0.2);
      padding: 0.3rem;
      border-radius: 10px;
  }

  .site-btn, .mode-btn {
      flex: 1 1 auto;            
      min-width: 0;           
      padding: 0.5rem 0.6rem;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: rgba(244, 240, 227, 0.65);
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
  }

  .site-btn:hover, .mode-btn:hover { color: #f4f0e3; }

  .site-btn.active, .mode-btn.active {
      background: var(--btn-active);
      color: #f5f5dc;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
  }

  @media (max-width: 480px) {
      .site-toggle, .mode-toggle {
          gap: 0.3rem;
          padding: 0.25rem;
      }
      .site-btn, .mode-btn {
          font-size: 0.78rem;
          padding: 0.45rem 0.5rem;
      }
  }

  .controls { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: flex-end; }
  .paste-controls { display: flex; flex-direction: column; gap: 0.6rem; }

  .textarea { resize: vertical; font-family: "JetBrains Mono", monospace; font-size: 0.82rem; line-height: 1.4; }
  .textarea-fen { resize: none; }

  .field { display: flex; flex-direction: column; gap: 0.3rem; flex: 1 1 10rem; min-width: 0; }
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

  /* --- Custom Select Dropdown Styles --- */
  .select-wrapper { position: relative; width: 100%; }

  .select-input {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    padding-right: 2.5rem;
    cursor: pointer;
    width: 100%;
  }

  .select-wrapper .dropdown-arrow {
    position: absolute;
    right: 0.8rem;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    color: var(--text-highlight);
    pointer-events: none;
    transition: transform 0.2s ease;
  }

  .select-input option {
    background-color: var(--bg-2);
    color: #f4f0e3;
    padding: 0.5rem;
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
    width: 0.85rem; height: 0.85rem;
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

  .info-note {
    color: #e8c37a;
    background: rgba(217, 179, 106, 0.1);
    border: 1px solid rgba(217, 179, 106, 0.3);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    font-size: 0.82rem;
  }

  .save-toast {
    color: #a8d97a;
    background: rgba(106, 209, 63, 0.12);
    border: 1px solid rgba(106, 209, 63, 0.3);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    font-size: 0.85rem;
    text-align: center;
  }

  /* --- Results browser (shared by fetch results + library) --- */
  .results { display: flex; flex-direction: column; gap: 0.6rem; }

  .results-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.8rem;
    color: rgba(244, 240, 227, 0.65);
    padding: 0 0.15rem;
  }

  .results-record { display: flex; gap: 0.45rem; font-weight: 700; }
  .rec-w { color: #8fc06a; }
  .rec-l { color: #d9736a; }
  .rec-d { color: #d9b36a; }

  .results-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    justify-content: space-between;
  }

  .tc-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }

  .tc-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.65rem;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.2);
    color: rgba(244, 240, 227, 0.75);
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tc-chip::before {
    content: '';
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--tc, #9a9a9a);
    flex-shrink: 0;
  }

  .tc-chip:hover { color: #f4f0e3; border-color: rgba(255, 255, 255, 0.25); }

  .tc-chip.active {
    border-color: var(--tc, var(--text-highlight));
    background: rgba(255, 255, 255, 0.08);
    color: #f5f5dc;
  }

  .chip-count {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.68rem;
    opacity: 0.7;
  }

  /* Time-control accent colors (chips + group badges) */
  .tc-chip.all, .tc-badge.all { --tc: #f4f0e3; }
  .tc-chip.ultrabullet, .tc-badge.ultrabullet { --tc: #ff6b6b; }
  .tc-chip.bullet, .tc-badge.bullet { --tc: #ff9f43; }
  .tc-chip.blitz, .tc-badge.blitz { --tc: #f2c14e; }
  .tc-chip.rapid, .tc-badge.rapid { --tc: #8fc06a; }
  .tc-chip.classical, .tc-badge.classical { --tc: #6aa8d9; }
  .tc-chip.correspondence, .tc-badge.correspondence { --tc: #a78bdb; }
  .tc-chip.daily, .tc-badge.daily { --tc: #a78bdb; }
  .tc-chip.unknown, .tc-badge.unknown { --tc: #9a9a9a; }

  .search-input { max-width: 11rem; flex: 0 1 11rem; padding: 0.35rem 0.6rem; font-size: 0.8rem; }

  .games-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-height: 50vh;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    width: 100%;
    box-sizing: border-box;
  }

  .tc-group { display: flex; flex-direction: column; gap: 0.35rem; }

  .tc-group-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.15rem 0.2rem;
  }

  .tc-badge {
    width: 9px; height: 9px;
    border-radius: 50%;
    background: var(--tc, #9a9a9a);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
    flex-shrink: 0;
  }

  .tc-name {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #f4f0e3;
  }

  .tc-stats {
    margin-left: auto;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    color: rgba(244, 240, 227, 0.55);
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .game-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
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

  .color-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25); }
  .color-dot.white { background: #f4f0e3; }
  .color-dot.black { background: #1a1a1a; }

  .opponent { flex: 1; min-width: 6rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .date {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    color: rgba(244, 240, 227, 0.5);
    flex-shrink: 0;
  }

  .rating { font-family: "JetBrains Mono", monospace; color: rgba(244, 240, 227, 0.6); font-size: 0.8rem; flex-shrink: 0; }

  .result { font-weight: 700; font-size: 0.85rem; flex-shrink: 0; }
  .result.win { color: #8fc06a; }
  .result.loss { color: #d9736a; }
  .result.draw { color: #d9b36a; }

  @media (max-width: 560px) {
    .rating { display: none; }
    .search-input { max-width: 100%; flex: 1 1 100%; }
  }

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

  .selection-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }

  .selected-msg { color: var(--text-highlight); font-weight: 700; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.5px; }

  .selection-players { color: #f4f0e3; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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

  .empty {
    color: rgba(244, 240, 227, 0.6);
    text-align: center;
    padding: 0.7rem;
    background: rgba(0, 0, 0, 0.15);
    border-radius: 8px;
    font-size: 0.85rem;
  }
</style>