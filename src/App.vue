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

  [data-theme="slate"] {
    --bg-1: #2c3644; 
    --bg-2: #3d4a5a; 
    --bg-3: #4f5f70;
    --panel-1: #3d4a5a; 
    --panel-2: #2c3644;
    --list-1: #4f5f70; 
    --list-2: #3d4a5a;
    --btn-active: #5b6d7e; 
    --btn-idle: #728496;
    --title-btn-active-1: #4f5f70; 
    --title-btn-active-2: #3d4a5a;
    --title-btn-idle-1: #728496; 
    --title-btn-idle-2: #4f5f70;
    --text-highlight: #cdd7e0;
    --board-light: #dde3e8; 
    --board-dark: #7c8ea0;
  }

  [data-theme="wood"] {
    --bg-1: #241a12; --bg-2: #3a2818; --bg-3: #58402a;
    --panel-1: #4a3320; --panel-2: #2e2013;
    --list-1: #6b4b30; --list-2: #4a3320;
    --btn-active: #2a1c10; --btn-idle: #6b4b30;
    --title-btn-active-1: #2c3e2e; --title-btn-active-2: #1b261c;
    --title-btn-idle-1: #4a634a; --title-btn-idle-2: #2c3e2e;
    --text-highlight: #f0d0a3;
    --board-light: #e0c99a; --board-dark: #2f2114;
  }

  [data-theme="blue"] {
    --bg-1: #16212e; --bg-2: #1f3145; --bg-3: #2a4560;
    --panel-1: #24374c; --panel-2: #17222f;
    --list-1: #2e4459; --list-2: #1e2d3d;
    --btn-active: #3a5b7a; --btn-idle: #5484a8;
    --title-btn-active-1: #274155; --title-btn-active-2: #1a2733;
    --title-btn-idle-1: #5484a8; --title-btn-idle-2: #274155;
    --text-highlight: #bcdcee;
    --board-light: #e2ebf1; --board-dark: #5f83a0;
  }

  [data-theme="purple"] {
    --bg-1: #1e1730; --bg-2: #2e2245; --bg-3: #3d2d5c;
    --panel-1: #2f2347; --panel-2: #1e1730;
    --list-1: #3d2d5c; --list-2: #2a2040;
    --btn-active: #55407a; --btn-idle: #7a5fa3;
    --title-btn-active-1: #453a5e; --title-btn-active-2: #332a45;
    --title-btn-idle-1: #7a5fa3; --title-btn-idle-2: #453a5e;
    --text-highlight: #cbb0e8;
    --board-light: #ebe3f5; --board-dark: #8e72b3;
  }

  [data-theme="green"] {
    --bg-1: #182219; --bg-2: #223221; --bg-3: #2e4530;
    --panel-1: #263a27; --panel-2: #172417;
    --list-1: #33502f; --list-2: #22321f;
    --btn-active: #3f5c3f; --btn-idle: #5c8a5c;
    --title-btn-active-1: #33502f; --title-btn-active-2: #22321f;
    --title-btn-idle-1: #5c8a5c; --title-btn-idle-2: #33502f;
    --text-highlight: #b8dcae;
    --board-light: #edf1e0; --board-dark: #6f9160;
  }

  [data-theme="cherry"] {
    --bg-1: #240f0f; --bg-2: #401a1a; --bg-3: #5c2222;
    --panel-1: #401a1a; --panel-2: #260f0f;
    --list-1: #5c2222; --list-2: #401a1a;
    --btn-active: #7a2f2f; --btn-idle: #a04545;
    --title-btn-active-1: #543030; --title-btn-active-2: #3d2222;
    --title-btn-idle-1: #6e4444; --title-btn-idle-2: #543030;
    --text-highlight: #e8a898;
    --board-light: #f0ddd3; --board-dark: #b06a58;
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