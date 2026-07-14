<script setup>
  import { ref, computed, onMounted } from 'vue' // Added onMounted
  import { useRoute, useRouter } from 'vue-router' // Added useRoute and useRouter
  import { auth } from '../firebase'
  import { onAuthStateChanged, signOut } from 'firebase/auth'

  const currentUser = ref(null)
  const router = useRouter() // Initialize the router instance
  const route = useRoute()   // Grab the current route object

  onMounted(() => {
    onAuthStateChanged(auth, (user) => {
      currentUser.value = user
    })
  })

  async function handleLogout() {
    await signOut(auth)
  }

  function showAuthModal(type) {
    router.push({ path: '/Review', query: { auth: type } })
  }

  const activeColor = "var(--title-btn-active-1), var(--title-btn-active-2)"
  const idleColor = "var(--title-btn-idle-1), var(--title-btn-idle-2)"

  function bgColor(buttonName) {
    return activeButton.value === buttonName ? activeColor : idleColor
  }

  function analyzeClick() {
    router.push('/')
  }

  function importClick() {
    router.push('/Review')
  }

  function gameClick() {
    router.push('/vsComputer')
  }

  const activeButton = computed(() => {
    if (route.path === '/Review') return 'import'
    if (route.path === '/Analysis') return 'analyze'
    if (route.path === '/vsComputer') return 'computer'
    return 'analyze'
  })
</script>


<template>
  <div class="title-container">
    <h1 class="title">♔ CHESSERLY</h1>
    <button
      class="btn"
      :style="{ background: `linear-gradient(${bgColor('import')})` }"
      @click="importClick()"
    >
      🎮 GameImport
    </button>

    <button
      class="btn"
      :style="{ background: `linear-gradient(${bgColor('analyze')})` }"
      @click="analyzeClick()"
    >
      🔎 Analyse
    </button>

    <!-- Disabled VS Computer -->
    <button
      class="btn tooltip-btn"
      :style="{ background: `linear-gradient(${bgColor('computer')})` }"
      @click="gameClick()"
      disabled
      data-tooltip="Coming soon..."
    >
      🤖 VS Computer
    </button>

    <!-- Disabled Puzzles -->
    <button
      class="btn tooltip-btn"
      :style="{ background: `linear-gradient(${bgColor('puzzles')})` }"
      disabled
      data-tooltip="Coming soon..."
    >
      🧩 Puzzles
    </button>
  </div>
</template>

<style scoped>
  .title-container {
    display: flex;
    align-items: center;
    flex-direction: column;
    margin-top: -0.5rem;
    margin-left: 2%;
    width: clamp(10rem, 20.7vw, 20rem);
    height: clamp(25rem, 37rem, 45rem);
    padding: 3%;
    box-sizing: border-box;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 15px 35px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.1);
  }

  .title {
    font-family: serif;
    text-align: center;
    margin-top: 2rem;
    margin-bottom: 2rem;
    font-size: clamp(1.4rem, 2.6vw, 2rem);
    font-weight: 700;
    letter-spacing: 1px;

    background: linear-gradient(90deg, #d4a373, #faedcd);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;

    user-select: none;
  }

  button {
    width: clamp(3rem, 100%, 12.5rem);
    height: clamp(2.8rem, 5vh, 3.2rem);
    border-radius: 12px;
    border: none;
    margin-top: 1.5rem;

    font-size: clamp(15px, 1.5vw, 17px);
    font-weight: 600;
    letter-spacing: 0.4px;
    color: #fefefe;

    cursor: pointer;
    transition: transform 0.25s ease, box-shadow 0.25s ease, background 0.25s ease;
  }

  .btn {
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35);
  }

  button:hover:not(:disabled) {
    transform: translateY(-2px) scale(1.03);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
  }

  button:active:not(:disabled) {
    transform: translateY(0) scale(0.99);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.35);
  }

  button:focus-visible {
    outline: 2px solid #faedcd;
    outline-offset: 3px;
  }

  /* Styling for disabled states */
  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    transform: none !important;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
  }

  /* Instant Tooltip Implementation */
  .tooltip-btn {
    position: relative;
  }

  /* The tooltip box */
  .tooltip-btn::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: 115%;
    left: 50%;
    transform: translateX(-50%);
    background-color: rgba(0, 0, 0, 0.85);
    color: #fff;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0s; /* 0s ensures it shows up instantly */
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
    z-index: 10;
  }

  /* Tiny arrow below the tooltip box */
  .tooltip-btn::before {
    content: "";
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    border-width: 6px;
    border-style: solid;
    border-color: rgba(0, 0, 0, 0.85) transparent transparent transparent;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0s;
    z-index: 10;
  }

  /* Trigger tooltip instantly on hover */
  .tooltip-btn:hover::after,
  .tooltip-btn:hover::before {
    opacity: 1;
  }

  @media (max-width: 767px) {
    .title-container {
      flex-direction: row;
      flex-wrap: wrap;
      width: 100%;
      height: auto;
      margin: 0 0 1rem 0;
      padding: 0.75rem 1rem;
      justify-content: center;
      align-items: center;
      gap: 0.6rem;
    }
    .title {
      width: 100%;
      margin: 0 0 0.25rem 0;
      text-align: center;
    }
    button {
      margin-top: 0;
      flex: 1 1 auto;
      min-width: 6rem;
    }
    
    .tooltip-btn::after {
    bottom: 125%;
    }
  }
</style>