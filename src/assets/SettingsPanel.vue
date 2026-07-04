<script setup>
  import { ref } from 'vue'

  const props = defineProps({
    isOpen: Boolean,
    targetDepth: Number,
    soundOn: Boolean,
    showBestArrow: Boolean,
    boardTheme: String
  })

  const emit = defineEmits([
    'update:isOpen', 
    'update:targetDepth', 
    'update:soundOn', 
    'update:showBestArrow',
    'update:boardTheme',
    'depthChanged'
  ])

  const themes = ['brown', 'blue', 'green', 'purple', 'wood']

  function close() {
    emit('update:isOpen', false)
  }
</script>

<template>
  <Transition name="fade">
    <div v-if="isOpen" class="modal-overlay" @click.self="close">
      <div class="settings-modal">
        <div class="modal-header">
          <h2>UI & Engine Settings</h2>
          <button class="close-btn" @click="close">✕</button>
        </div>
        
        <div class="settings-content">
          <!-- Engine Depth -->
          <div class="setting-group">
            <label>
              Search Depth <span class="highlight">{{ targetDepth }}</span>
            </label>
            <input 
              type="range" min="10" max="30" step="1"
              :value="targetDepth"
              @input="emit('update:targetDepth', Number($event.target.value))"
              @change="emit('depthChanged')"
            />
          </div>

          <!-- Toggles -->
          <div class="setting-group toggles">
            <label class="toggle-label">
              <span>Move Sounds</span>
              <input type="checkbox" :checked="soundOn" @change="emit('update:soundOn', $event.target.checked)">
            </label>
            <label class="toggle-label">
              <span>Best Move Arrow</span>
              <input type="checkbox" :checked="showBestArrow" @change="emit('update:showBestArrow', $event.target.checked)">
            </label>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }

  .settings-modal {
    background: linear-gradient(145deg, #2a2a2a, #1a1a1a);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    width: 90%;
    max-width: 400px;
    color: #f4f0e3;
    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    font-family: 'Inter', sans-serif;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.2rem 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .modal-header h2 { margin: 0; font-size: 1.2rem; }

  .close-btn {
    background: transparent;
    border: none;
    color: #888;
    font-size: 1.5rem;
    cursor: pointer;
    transition: color 0.2s;
  }
  .close-btn:hover { color: #fff; }

  .settings-content { padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }

  .setting-group { display: flex; flex-direction: column; gap: 0.5rem; }
  .setting-group label { font-size: 0.9rem; font-weight: 600; display: flex; justify-content: space-between; }
  .highlight { color: #d9b382; font-family: monospace; }

  input[type="range"] {
    accent-color: #d9b382;
    width: 100%;
  }

  .toggles { gap: 1rem; }
  .toggle-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
  }

  .theme-select {
    background: rgba(0,0,0,0.3);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.2);
    padding: 0.5rem;
    border-radius: 8px;
    outline: none;
  }

  .fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
  .fade-enter-from, .fade-leave-to { opacity: 0; }
</style>