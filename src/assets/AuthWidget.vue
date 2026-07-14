<script setup>
  import { ref, onMounted } from 'vue'
  import { auth } from '../firebase'
  import { 
    onAuthStateChanged, 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signOut 
  } from 'firebase/auth'

  const currentUser = ref(null)
  const authEmail = ref('')
  const authPassword = ref('')
  const isRegistering = ref(false)
  const authError = ref(null)
  const showAuthForm = ref(false)

  onMounted(() => {
    onAuthStateChanged(auth, (user) => {
      currentUser.value = user
      if (!user) showAuthForm.value = false
    })
  })

  function openAuth(mode) {
    isRegistering.value = mode === 'register'
    authError.value = null
    showAuthForm.value = true
  }

  async function handleAuth() {
    authError.value = null
    try {
      if (isRegistering.value) {
        await createUserWithEmailAndPassword(auth, authEmail.value, authPassword.value)
      } else {
        await signInWithEmailAndPassword(auth, authEmail.value, authPassword.value)
      }
      authEmail.value = ''
      authPassword.value = ''
      showAuthForm.value = false
    } catch (e) {
      authError.value = e.message
    }
  }

  async function handleLogout() {
    await signOut(auth)
  }
</script>

<template>
  <div class="auth-widget">
    <template v-if="!currentUser">
      <div class="auth-buttons" v-if="!showAuthForm">
        <button class="auth-btn" @click="openAuth('login')">Log In</button>
        <button class="auth-btn signup" @click="openAuth('register')">Sign Up</button>
      </div>

      <div class="auth-form" v-else>
        <button class="close-btn" @click="showAuthForm = false">×</button>
        <h3 class="auth-form-title">{{ isRegistering ? 'Create Account' : 'Sign In' }}</h3>
        <input v-model="authEmail" type="email" placeholder="Email" class="auth-input" />
        <input v-model="authPassword" type="password" placeholder="Password" class="auth-input" @keyup.enter="handleAuth" />
        <button class="auth-submit" @click="handleAuth">{{ isRegistering ? 'Register' : 'Login' }}</button>
        <p v-if="authError" class="auth-error">{{ authError }}</p>
      </div>
    </template>

    <!-- Clean User Avatar Menu (Replaces the annoying email box) -->
    <div v-else class="user-menu-container">
      <div class="user-avatar">
        {{ currentUser.email ? currentUser.email[0].toUpperCase() : 'U' }}
      </div>
      <div class="user-dropdown">
        <p class="dropdown-email">{{ currentUser.email }}</p>
        <button class="logout-btn" @click="handleLogout">Logout</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .auth-widget {
    position: fixed;
    top: 1rem;
    right: 1rem;
    z-index: 1000;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  }

  .auth-buttons {
    display: flex;
    gap: 0.5rem;
  }

  .auth-btn {
    padding: 0.5rem 1rem;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(6px);
    color: #f4f0e3;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .auth-btn:hover { background: rgba(0, 0, 0, 0.7); transform: translateY(-1px); }

  .auth-btn.signup {
    background: linear-gradient(145deg, var(--title-btn-active-1), var(--title-btn-active-2));
    border: none;
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1.25rem;
    background: rgba(20, 15, 10, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    width: 260px;
    position: relative;
  }

  .close-btn {
    position: absolute;
    top: 0.5rem;
    right: 0.75rem;
    background: none;
    border: none;
    color: rgba(244, 240, 227, 0.6);
    font-size: 1.4rem;
    line-height: 1;
    cursor: pointer;
  }
  .close-btn:hover { color: #fff; }

  .auth-form-title {
    font-family: serif;
    text-align: center;
    color: #faedcd;
    font-size: 1.2rem;
    margin: 0 0 0.25rem;
  }

  .auth-input {
    padding: 0.55rem 0.7rem;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.4);
    color: #f4f0e3;
    font-size: 0.9rem;
    width: 100%;
    box-sizing: border-box;
  }

  .auth-input:focus { outline: none; border-color: #faedcd; }

  .auth-submit {
    padding: 0.6rem;
    border-radius: 8px;
    border: none;
    background: linear-gradient(145deg, var(--title-btn-active-1), var(--title-btn-active-2));
    color: #fff;
    font-weight: 700;
    font-size: 0.95rem;
    cursor: pointer;
    transition: transform 0.2s;
    margin-top: 0.25rem;
  }

  .auth-submit:hover { transform: translateY(-1px); }

  .auth-error {
    color: #ffb0a8;
    font-size: 0.8rem;
    margin: 0;
    text-align: center;
    word-break: break-word;
  }

  /* Clean Avatar Dropdown */
  .user-menu-container {
    position: relative;
    width: 42px;
    height: 42px;
  }

  .user-avatar {
    width: 100%;
    height: 100%;
    background: linear-gradient(145deg, var(--title-btn-active-1), var(--title-btn-active-2));
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #fff;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 1.1rem;
    cursor: pointer;
    box-shadow: 0 4px 10px rgba(0,0,0,0.4);
    transition: transform 0.2s ease;
  }

  .user-menu-container:hover .user-avatar {
    transform: scale(1.05);
  }

  .user-dropdown {
    position: absolute;
    top: 110%;
    right: 0;
    background: rgba(20, 15, 10, 0.95);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1rem;
    min-width: 220px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    
    /* Hidden by default */
    opacity: 0;
    visibility: hidden;
    transform: translateY(-10px);
    transition: all 0.2s ease;
  }

  .user-menu-container:hover .user-dropdown {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }

  .dropdown-email {
    color: #faedcd;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: center;
    word-break: break-all;
    margin: 0;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(255,255,255,0.1);
    width: 100%;
    box-sizing: border-box;
  }

  .logout-btn {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    border: 1px solid rgba(255, 100, 100, 0.3);
    background: rgba(255, 100, 100, 0.15);
    color: #ffb0a8;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
    width: 100%;
  }
  .logout-btn:hover { background: rgba(255, 100, 100, 0.3); }
</style>