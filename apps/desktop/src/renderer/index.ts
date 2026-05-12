document.body.style.cssText = [
  'margin: 0',
  'display: flex',
  'align-items: center',
  'justify-content: center',
  'min-height: 100vh',
  'font-family: system-ui, -apple-system, sans-serif',
  'font-size: 20px',
].join('; ');

const message = document.createElement('div');
message.textContent = 'xCLAUDE Gateway — Hito 1';
document.body.appendChild(message);
