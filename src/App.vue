<script setup>
  import { ref } from 'vue' 
</script>

<template>
  <RouterView/>
</template>

<style>
  /*
    Each theme now also defines --board-light / --board-dark, used to paint
    the actual chessboard squares (see Analysis.vue's :deep(.cg-board) rule),
    so the board itself follows the selected theme instead of staying a fixed
    brown regardless of what's picked in Settings.

    Palette pass: the old blue/green/cherry variants used near-saturated
    "web UI" colors (#0ea5e9, #10b981, #dc2626) that clashed with the
    wood-panel aesthetic. All accent colors below are pulled in toward
    lower saturation / mid brightness so nothing reads as a bright web button.
  */

  :root, [data-theme="brown"] {
    --bg-1: #4b2e12; --bg-2: #6f4518; --bg-3: #7f4f24;
    --panel-1: #8B5A32; --panel-2: #6D4524;
    --list-1: #a57548; --list-2: #7d5530;
    --btn-active: #5e3c20; --btn-idle: #8d5b33;
    --title-btn-active-1: #414833; --title-btn-active-2: #333d29;
    --title-btn-idle-1: #656d4a; --title-btn-idle-2: #414833;
    --text-highlight: #d9b382;
    --board-light: #e8d9b5; --board-dark: #b58863;
  }

  [data-theme="midnight"] {
    --bg-1: #000000; --bg-2: #111111; --bg-3: #222222;
    --panel-1: #1a1a1a; --panel-2: #0a0a0a;
    --list-1: #2a2a2a; --list-2: #1a1a1a;
    --btn-active: #444444; 
    --btn-idle: #5c5c5c;
    --title-btn-active-1: #333333; 
    --title-btn-active-2: #111111;
    --title-btn-idle-1: #4d4d4d; 
    --title-btn-idle-2: #333333;
    --text-highlight: #cfcfcf;
    --board-light: #b8b8b8; 
    --board-dark: #4a4a4a;
  }

  [data-theme="wood"] {
    --bg-1: #241a12; --bg-2: #3a2818; --bg-3: #58402a;
    --panel-1: #4a3320; --panel-2: #2e2013;
    --list-1: #6b4b30; --list-2: #4a3320;
    --btn-active: #2a1c10; --btn-idle: #6b4b30;
    --title-btn-active-1: #2c3e2e; --title-btn-active-2: #1b261c;
    --title-btn-idle-1: #4a634a; --title-btn-idle-2: #2c3e2e;
    --text-highlight: #f0d0a3;
    --board-light: #e0c99a; --board-dark: #452f1d;
  }


  [data-theme="blue"] {
  --bg-1: #10151c; --bg-2: #161d26; --bg-3: #1c2530;
  --panel-1: #1a222c; --panel-2: #121820;
  --list-1: #202b38; --list-2: #161e28;
  --btn-active: #2f6690; --btn-idle: #3d4b5a;
  --title-btn-active-1: #24313e; --title-btn-active-2: #182029;
  --title-btn-idle-1: #3d4b5a; --title-btn-idle-2: #24313e;
  --text-highlight: #7ec8e3;
  --board-light: #dce6ec; --board-dark: #5f83a0;
}

[data-theme="purple"] {
  --bg-1: #120e1a; --bg-2: #17121f; --bg-3: #1e1828;
  --panel-1: #1b1524; --panel-2: #120e1a;
  --list-1: #221a2e; --list-2: #171220;
  --btn-active: #6b4c9a; --btn-idle: #453a52;
  --title-btn-active-1: #2a2135; --title-btn-active-2: #1a1522;
  --title-btn-idle-1: #453a52; --title-btn-idle-2: #2a2135;
  --text-highlight: #c9a3e8;
  --board-light: #e8e0f0; --board-dark: #8e72b3;
}

[data-theme="green"] {
  --bg-1: #0f1611; --bg-2: #131c15; --bg-3: #18241a;
  --panel-1: #151f17; --panel-2: #0f1611;
  --list-1: #1b2a1d; --list-2: #131c15;
  --btn-active: #4a7d4a; --btn-idle: #3a4a3c;
  --title-btn-active-1: #223124; --title-btn-active-2: #161e17;
  --title-btn-idle-1: #3a4a3c; --title-btn-idle-2: #223124;
  --text-highlight: #9ed48a;
  --board-light: #e8edda; --board-dark: #6f9160;
}

[data-theme="cherry"] {
  --bg-1: #170d0d; --bg-2: #1e1212; --bg-3: #261717;
  --panel-1: #1c1010; --panel-2: #140b0b;
  --list-1: #241414; --list-2: #1a0f0f;
  --btn-active: #9a3d3d; --btn-idle: #4a3232;
  --title-btn-active-1: #331e1e; --title-btn-active-2: #1e1212;
  --title-btn-idle-1: #4a3232; --title-btn-idle-2: #331e1e;
  --text-highlight: #f0a898;
  --board-light: #f0ddd3; --board-dark: #b06a58;
}

[data-theme="slate"] {
  --bg-1: #14181d; --bg-2: #1a1f26; --bg-3: #22282f;
  --panel-1: #1c2128; --panel-2: #14181d;
  --list-1: #262c34; --list-2: #1a1f26;
  --btn-active: #4a5a6a; --btn-idle: #34404a;
  --title-btn-active-1: #262e36; --title-btn-active-2: #1a1f26;
  --title-btn-idle-1: #34404a; --title-btn-idle-2: #262e36;
  --text-highlight: #a8bcc9;
  --board-light: #dde3e8; --board-dark: #7c8ea0;
}
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  html, body {
    width: 100%;
    height: 100%;
  }

  body {
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: #e6e6e6;
      background: linear-gradient(
        135deg,
        var(--bg-1) 0%,
        var(--bg-2) 45%,
        var(--bg-3) 100%
      );
      line-height: 1.5;
      background-attachment: fixed;
  }

  body, button {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  ol, ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  button {
    font-family: inherit;
    cursor: pointer;
  }

  img {
    max-width: 100%;
    display: block;
  }

  .app-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    max-width: 1600px;
    margin: 0 auto;
    align-items: start;
    padding: 1rem;
    gap: 1rem;
  }
</style>