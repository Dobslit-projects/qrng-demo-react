export const gameKeyframes = `
@keyframes diceTumble {
  0% { transform: perspective(600px) rotateX(0deg) rotateY(0deg) rotateZ(0deg) scale(1); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  15% { transform: perspective(600px) rotateX(120deg) rotateY(60deg) rotateZ(30deg) scale(1.08); box-shadow: 0 8px 20px rgba(0,0,0,0.2); }
  30% { transform: perspective(600px) rotateX(240deg) rotateY(180deg) rotateZ(-20deg) scale(1.12); box-shadow: 0 12px 24px rgba(0,0,0,0.25); }
  50% { transform: perspective(600px) rotateX(360deg) rotateY(270deg) rotateZ(45deg) scale(1.05); box-shadow: 0 6px 16px rgba(0,0,0,0.15); }
  70% { transform: perspective(600px) rotateX(480deg) rotateY(360deg) rotateZ(-15deg) scale(1.1); box-shadow: 0 10px 22px rgba(0,0,0,0.2); }
  85% { transform: perspective(600px) rotateX(600deg) rotateY(450deg) rotateZ(10deg) scale(1.04); box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
  100% { transform: perspective(600px) rotateX(720deg) rotateY(540deg) rotateZ(0deg) scale(1); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
}

@keyframes diceSettle {
  0% { transform: scale(1.2) translateY(-10px); box-shadow: 0 0 30px 8px currentColor; }
  30% { transform: scale(0.9) translateY(3px); box-shadow: 0 0 15px 4px currentColor; }
  50% { transform: scale(1.08) translateY(-4px); box-shadow: 0 0 20px 5px currentColor; }
  70% { transform: scale(0.97) translateY(1px); box-shadow: 0 0 8px 2px currentColor; }
  100% { transform: scale(1) translateY(0); box-shadow: 0 0 0 0 currentColor; }
}

@keyframes coinSpin {
  0% { transform: perspective(800px) rotateY(0deg) scale(1); }
  10% { transform: perspective(800px) rotateY(180deg) scale(1.1); }
  25% { transform: perspective(800px) rotateY(540deg) scale(1.15); }
  50% { transform: perspective(800px) rotateY(1080deg) scale(1.1); }
  75% { transform: perspective(800px) rotateY(1260deg) scale(1.05); }
  90% { transform: perspective(800px) rotateY(1380deg) scale(1.02); }
  100% { transform: perspective(800px) rotateY(1440deg) scale(1); }
}

@keyframes coinLand {
  0% { transform: scale(1.12) translateY(-8px); box-shadow: 0 0 24px 6px currentColor; }
  30% { transform: scale(0.9) translateY(3px); box-shadow: 0 0 10px 3px currentColor; }
  50% { transform: scale(1.06) translateY(-2px); }
  70% { transform: scale(0.97) translateY(1px); }
  100% { transform: scale(1) translateY(0); box-shadow: none; }
}

@keyframes ballBounceIn {
  0% { transform: translateY(40px) scale(0.3); opacity: 0; }
  50% { transform: translateY(-10px) scale(1.15); opacity: 1; }
  70% { transform: translateY(4px) scale(0.95); }
  85% { transform: translateY(-2px) scale(1.03); }
  100% { transform: translateY(0) scale(1); opacity: 1; }
}

@keyframes ballShimmer {
  0% { box-shadow: 0 0 0 0 currentColor; }
  50% { box-shadow: 0 0 14px 4px currentColor; }
  100% { box-shadow: 0 0 0 0 currentColor; }
}

@keyframes slotSpin {
  0% { transform: translateY(0); }
  100% { transform: translateY(-100%); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
`;
