<script setup>
	import { ref, computed } from 'vue' 
  import { useRouter, useRoute } from 'vue-router'

  const router = useRouter()
  const route = useRoute()

  const activeColor = "135deg, #414833, #333d29"
  const idleColor = "135deg, #656d4a, #414833"


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
    <h1 class="title">♔ ChessLab</h1>

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

    <button
      class="btn"
      :style="{ background: `linear-gradient(${bgColor('computer')})` }"
      @click="gameClick()"
    >
      🤖 VS Computer
    </button>

    <button
      class="btn"
      :style="{ background: `linear-gradient(${bgColor('puzzles')})` }"
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
		background: linear-gradient(145deg, #8B5A32, #6D4524);
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


	button:hover {
		transform: translateY(-2px) scale(1.03);
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
	}

	button:active {
		transform: translateY(0) scale(0.99);
		box-shadow: 0 6px 14px rgba(0, 0, 0, 0.35);
	}

	button:focus-visible {
		outline: 2px solid #faedcd;
		outline-offset: 3px;
	}
</style>