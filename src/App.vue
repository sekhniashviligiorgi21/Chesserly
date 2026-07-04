<script setup>
  import { ref } from 'vue' 
</script>

<template>
  <RouterView/>
</template>

<style>
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
        #4b2e12 0%,
        #6f4518 45%,
        #7f4f24 100%
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

  /* Rotate the whole page */
  html {
    filter: hue-rotate();
  }

  /* Rotate images back by the same amount so they look normal */
  img, video {
    filter: hue-rotate();
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

