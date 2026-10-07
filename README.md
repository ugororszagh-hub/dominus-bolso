# DOMINUS de bolso

Página do Dominus (assistente de voz do projeto GOD TRADING) para o celular: https://ugororszagh-hub.github.io/dominus-bolso/

A página só desenha o busto 3D, ouve pelo microfone do celular e toca a resposta. O cérebro é o PC do Ugor
(`GOD-TRADING\dominus\dominus_bolso.py`), alcançado por um túnel HTTPS cuja URL fica em `backend.json`.
Sem o PC ligado com o `DOMINUS-BOLSO.bat`, a página fica "fora do ar". Toda pergunta exige um token que não está aqui.

Arquivos: `index.html` (página), `bolso3d.js` (busto 3D, cópia de `painel/dominus3d.js`), `dominus.glb` (modelo),
`vendor/` (three.js r165, MIT), `backend.json` (URL atual do PC, escrita pelo próprio PC ao subir).
