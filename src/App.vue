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
  
  [data-theme="blue"] {
    /* Deep slate/navy backgrounds */
    --bg-1: #0f172a; --bg-2: #162032; --bg-3: #1e293b;
    --panel-1: #162438; --panel-2: #0b1121;
    --list-1: #1e2e45; --list-2: #131c2d;
    
    /* Contrast Accent: Warm Amber / Gold */
    --btn-active: #d97706; --btn-idle: #f59e0b;
    --title-btn-active-1: #b45309; --title-btn-active-2: #78350f;
    --title-btn-idle-1: #f59e0b; --title-btn-idle-2: #d97706;
    
    --text-highlight: #93c5fd;
    /* Classic pleasing blue chess board */
    --board-light: #d8e1e8; --board-dark: #5e7d9e;
  }

  [data-theme="purple"] {
    /* Muted charcoal/aubergine backgrounds */
    --bg-1: #15101c; --bg-2: #1c1526; --bg-3: #281e36;
    --panel-1: #20172e; --panel-2: #120d18;
    --list-1: #2a1f3a; --list-2: #1b1325;
    
    /* Contrast Accent: Electric Gold / Yellow */
    --btn-active: #ca8a04; --btn-idle: #eab308;
    --title-btn-active-1: #a16207; --title-btn-active-2: #713f12;
    --title-btn-idle-1: #eab308; --title-btn-idle-2: #ca8a04;
    
    --text-highlight: #d8b4fe;
    /* Lavender-tinted board */
    --board-light: #e5dfee; --board-dark: #81669c;
  }

  [data-theme="green"] {
    /* Extremely dark desaturated forest backgrounds */
    --bg-1: #111411; --bg-2: #161c16; --bg-3: #1f281f;
    --panel-1: #192119; --panel-2: #0f120f;
    --list-1: #212c21; --list-2: #161d16;
    
    /* Contrast Accent: Energetic Coral / Orange */
    --btn-active: #ea580c; --btn-idle: #f97316;
    --title-btn-active-1: #c2410c; --title-btn-active-2: #7c2d12;
    --title-btn-idle-1: #f97316; --title-btn-idle-2: #ea580c;
    
    --text-highlight: #86efac;
    /* Classic iconic chess green board */
    --board-light: #eaebd1; --board-dark: #1f2b20;
  }

  [data-theme="cherry"] {
    /* Very dark, warm charcoal backgrounds */
    --bg-1: #1a1212; --bg-2: #241616; --bg-3: #301d1d;
    --panel-1: #261717; --panel-2: #140d0d;
    --list-1: #331e1e; --list-2: #211313;
    
    /* Contrast Accent: Bright Teal / Cyan */
    --btn-active: #0891b2; --btn-idle: #06b6d4;
    --title-btn-active-1: #0369a1; --title-btn-active-2: #075985;
    --title-btn-idle-1: #06b6d4; --title-btn-idle-2: #0891b2;
    
    --text-highlight: #fca5a5;
    /* Warm terracotta and cream board */
    --board-light: #edd8d3; --board-dark: #b35952;
  }

  [data-theme="slate"] {
    /* Cool, metallic dark greys */
    --bg-1: #13151a; --bg-2: #1b1e24; --bg-3: #242830;
    --panel-1: #1d2027; --panel-2: #101216;
    --list-1: #262b34; --list-2: #191c22;
    
    /* Contrast Accent: Electric Violet / Purple */
    --btn-active: #4f46e5; --btn-idle: #6366f1;
    --title-btn-active-1: #3730a3; --title-btn-active-2: #312e81;
    --title-btn-idle-1: #6366f1; --title-btn-idle-2: #4f46e5;
    
    --text-highlight: #cbd5e1;
    /* Icy grey/blue board */
    --board-light: #dde2e8; --board-dark: #6f7f94;
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