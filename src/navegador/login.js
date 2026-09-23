'use strict';

/**
 * Abre o Facebook com perfil persistente para login MANUAL.
 * Não solicita nem armazena senha no código.
 *
 * Uso:
 *   npm run browser:login
 *
 * Faça login na janela, complete 2FA se pedir, depois pressione Enter no terminal.
 */

const { criarContexto, novaPagina, SESSION_DIR } = require('./browser');
const { verificarSessaoLogada } = require('./facebook');

async function main() {
  console.log('========================================');
  console.log(' LOGIN MANUAL — Facebook (sessão local)');
  console.log('========================================');
  console.log('Perfil persistente:', SESSION_DIR);
  console.log('A senha NÃO é lida pelo script.');
  console.log('1. Faça login na janela do navegador');
  console.log('2. Complete verificação/2FA se aparecer');
  console.log('3. Volte aqui e pressione ENTER');
  console.log('');

  const context = await criarContexto({ headless: false });
  const page = await novaPagina(context);

  await page.goto('https://www.facebook.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  const status = await verificarSessaoLogada(page);
  if (status.ok) {
    console.log('✅ Sessão parece autenticada. Pode rodar o teste de publicação.');
  } else {
    console.log('⚠️  Sessão não confirmada:', status.motivo);
    console.log('Tente de novo se o login não tiver sido concluído.');
  }

  await context.close();
  process.exit(status.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Erro no login:', err.message);
  process.exit(1);
});
