'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

console.log('========================================');
console.log(' DIAGNÓSTICO DO NAVEGADOR');
console.log('========================================');

console.log('\nNode.js:');
console.log(process.version);

console.log('\nArquitetura:');
console.log(process.arch);

console.log('\nSistema:');
console.log(process.platform);

console.log('\nChromium/Chrome encontrados:');

const candidatos = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

let encontrado = false;

for (const caminho of candidatos) {
  if (fs.existsSync(caminho)) {
    console.log(`✅ ${caminho}`);
    encontrado = true;

    try {
      const versao = execSync(`"${caminho}" --version`, {
        encoding: 'utf8',
        timeout: 10000,
      }).trim();

      console.log(`   Versão: ${versao}`);
    } catch (erro) {
      console.log('   ⚠️ Não foi possível obter a versão.');
    }
  }
}

if (!encontrado) {
  console.log('❌ Nenhum Chromium/Chrome encontrado nos caminhos padrão.');
}

console.log('\nComandos disponíveis:');

for (const comando of ['chromium', 'chromium-browser', 'google-chrome']) {
  try {
    const resultado = execSync(`command -v ${comando}`, {
      encoding: 'utf8',
      timeout: 5000,
      shell: '/bin/sh',
    }).trim();

    if (resultado) {
      console.log(`✅ ${comando}: ${resultado}`);
    }
  } catch (_) {
    // Comando não encontrado.
  }
}

console.log('\n========================================');
console.log(' FIM DO DIAGNÓSTICO');
console.log('========================================');
