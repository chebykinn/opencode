#!/usr/bin/env node

/**
 * Sheep Counter Script
 * Counts sheep for exactly 1 minute with claps every 5 sheep
 */

const TOTAL_DURATION = 60 * 1000 // 1 minute in milliseconds
const SHEEP_DELAY = 800 // Delay between sheep in milliseconds

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function countSheep() {
  console.log("🐑 Starting sheep counting for 1 minute...\n")

  const startTime = Date.now()
  let sheepCount = 0

  while (Date.now() - startTime < TOTAL_DURATION) {
    sheepCount++

    // Every 5 sheep, print a clap header
    if (sheepCount % 5 === 1 && sheepCount > 1) {
      console.log("\n## 👏 clap\n")
    }

    // Print the sheep count
    console.log(`${sheepCount} sheep...`)

    // Wait before next sheep, but check if we have time remaining
    const elapsed = Date.now() - startTime
    const timeRemaining = TOTAL_DURATION - elapsed

    if (timeRemaining > SHEEP_DELAY) {
      await sleep(SHEEP_DELAY)
    } else if (timeRemaining > 0) {
      // If less than full delay remaining, sleep for remaining time
      await sleep(timeRemaining)
      break
    } else {
      break
    }
  }

  const finalTime = Date.now() - startTime
  console.log(`\n🎉 Finished! Counted ${sheepCount} sheep in ${(finalTime / 1000).toFixed(1)} seconds.`)
}

// Run the sheep counter
countSheep().catch(console.error)
