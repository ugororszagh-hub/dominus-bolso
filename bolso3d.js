/* DOMINUS — busto 3D (modelo Tripo do Ugor em painel\dominus.glb) com boca sincronizada à voz e movimento humano.
   Carregado por jarvis.html como módulo; three.js local em painel\vendor (sem CDN).
   Entrada: window.DOMINUS_3D.voz(hb, noAr) a cada leitura do heartbeat de dominus_voz.py.
     hb.estado = parado | ouvindo | pensando | falando ; hb.nivel = nível do microfone
     hb.fala = {t0, dur, texto, env[]} -> envelope de amplitude da frase que está tocando (25 Hz)
   O modelo é malha estática (sem esqueleto): cabeça e tronco são movidos no vertex shader por dois pivôs
   (pescoço e base), por faixa de altura — um "esqueleto" de duas juntas. Nada aqui calcula número do projeto. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const canvas = document.getElementById('av3d');
if (!canvas) throw new Error('dominus3d: #av3d não existe');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- calibração do modelo (frações da altura/largura do busto; ajustadas por inspeção visual) ---------- */
const CAL = {
  bocaY: 0.715,       // altura da fenda da boca (0 = base do busto, 1 = topo da cabeça) — medido na régua b1_grid.jpg
  pescocoY: 0.60,     // altura da junta do pescoço (acima: cabeça)
  bocaR: 0.055,       // meia-largura da boca, fração da LARGURA do busto (cabeça = ~27% da largura)
  queixo: 0.04,       // queda da placa do queixo com a boca toda aberta, fração da altura
  alturaCena: 1.78,   // altura do busto em unidades de cena (câmera fixa) — 1.65 antes; "um pouco maior" (06/10)
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(18, 1, 0.05, 50);
camera.position.set(0, 0.05, 7.6); camera.lookAt(0, 0.05, 0);
// Materiais e texturas do GLB como vieram da Tripo (PBR), iluminados por um ambiente neutro + luz principal:
// o visual é o do arquivo, não uma releitura.
// Holograma: a cor final é calculada no shader (ciano translúcido, bordas acesas, varredura), como no
// visualizador da Tripo em que o Ugor aprovou o modelo. Luzes/ambiente não influenciam.
const head = new THREE.Group(); scene.add(head);

const UNI = {
  uTime: { value: 0 }, uInt: { value: 1 }, uTint: { value: new THREE.Color('#3ee6ff') }, uTintMix: { value: 0 }, uEmis: { value: 1.6 },
  uMouth: { value: new THREE.Vector3() }, uMouthY: { value: 0 }, uMouthR: { value: 0.1 }, uJaw: { value: 0.05 },
  uUp: { value: new THREE.Vector3(0, 1, 0) }, uFwd: { value: new THREE.Vector3(0, 0, 1) }, uSide: { value: new THREE.Vector3(1, 0, 0) },
  // pseudo-esqueleto: pivô do pescoço e da base (alturas locais), rotações (yaw, pitch, roll) da cabeça e do tronco, respiração
  uNeckY: { value: 0 }, uBaseY: { value: 0 }, uTopY: { value: 1 }, uHead: { value: new THREE.Vector3() }, uTorso: { value: new THREE.Vector3() }, uBreath: { value: 0 },
};
const MODEL = { pronto: false };

function prepararMalha(o) {
  o.frustumCulled = false;
  const q = o.getWorldQuaternion(new THREE.Quaternion()), inv = q.clone().invert();
  UNI.uUp.value = new THREE.Vector3(0, 1, 0).applyQuaternion(inv);
  UNI.uFwd.value = new THREE.Vector3(0, 0, 1).applyQuaternion(inv);
  UNI.uSide.value = new THREE.Vector3(1, 0, 0).applyQuaternion(inv);
  o.geometry.computeBoundingBox();
  const lb = o.geometry.boundingBox, cs = [];
  for (const x of [lb.min.x, lb.max.x]) for (const y of [lb.min.y, lb.max.y]) for (const z of [lb.min.z, lb.max.z]) cs.push(new THREE.Vector3(x, y, z));
  const rng = v => { const d = cs.map(c => c.dot(v)); return [Math.min(...d), Math.max(...d)]; };
  const [h0, h1] = rng(UNI.uUp.value), [s0, s1] = rng(UNI.uSide.value);
  MODEL.local = { h0, h1, w: s1 - s0 };
  aplicarCal();
  const m = o.material;
  m.transparent = true; m.blending = THREE.AdditiveBlending; m.depthWrite = false; m.side = THREE.FrontSide;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, UNI);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uMouthY,uMouthR,uJaw,uNeckY,uBaseY,uTopY,uBreath; uniform vec3 uMouth,uUp,uFwd,uSide,uHead,uTorso; varying float vGap; varying float vYm;
        vec3 mouthDeform(vec3 p, out float gap){
          float hgt=dot(p,uUp), fr=dot(p,uFwd), sd=dot(p,uSide);
          float front=smoothstep(0.0,0.5,fr/uMouthR);
          float wx=exp(-pow(sd/uMouthR,2.));
          float below=clamp((uMouthY-hgt)/(uMouthR*0.18),0.,1.);
          float reach=1.-smoothstep(uMouthY-uMouthR*1.6,uMouthY-uMouthR*2.6,hgt);
          p-=uUp*(uMouth.x*uJaw*wx*below*reach*front);
          float lip=exp(-pow((hgt-uMouthY)/(uMouthR*0.35),2.))*wx*front;
          p+=uSide*(sd*(uMouth.y*0.1-uMouth.z*0.16)*lip);
          p+=uUp*(uMouth.z*uMouthR*0.05*lip*sign(hgt-uMouthY));
          gap=uMouth.x*wx*front*below*(1.-below)*4.;
          return p;
        }
        // gira o ponto em torno de um pivô (altura h0 no eixo "up") por yaw (em torno de up), pitch (side) e roll (fwd)
        vec3 girar(vec3 p, float h0, vec3 ang){
          vec3 piv=uUp*h0; vec3 d=p-piv;
          float x=dot(d,uSide), y=dot(d,uUp), z=dot(d,uFwd);
          float c=cos(ang.x), s=sin(ang.x); float x1=c*x+s*z, z1=-s*x+c*z;          // yaw
          c=cos(ang.y); s=sin(ang.y); float y2=c*y-s*z1, z2=s*y+c*z1;                // pitch
          c=cos(ang.z); s=sin(ang.z); float x3=c*x1-s*y2, y3=s*x1+c*y2;              // roll
          return piv+uSide*x3+uUp*y3+uFwd*z2;
        }
        vec3 esqueleto(vec3 p){
          float hgt=dot(p,uUp);
          float faixa=max(uTopY-uBaseY,1e-4);
          float wHead=smoothstep(uNeckY-0.04*faixa,uNeckY+0.06*faixa,hgt);
          float wTorso=smoothstep(uBaseY,uBaseY+0.35*faixa,hgt);
          // respiração: o peito (entre a base e o pescoço) incha um pouco para frente e para os lados
          float wPeito=smoothstep(uBaseY,uBaseY+0.3*faixa,hgt)*(1.-wHead);
          p+=uFwd*(uBreath*0.012*faixa*wPeito)+uSide*(dot(p,uSide)*uBreath*0.01*wPeito);
          p=mix(p,girar(p,uBaseY,uTorso),wTorso);
          p=mix(p,girar(p,uNeckY,uHead),wHead);
          return p;
        }`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position); float gap; transformed = esqueleto(mouthDeform(transformed, gap)); vGap = gap; vYm = dot(position,uUp);`)
      .replace('#include <beginnormal_vertex>', `vec3 objectNormal = vec3(normal);
        { float hgt=dot(position,uUp); float faixa=max(uTopY-uBaseY,1e-4);
          float wHead=smoothstep(uNeckY-0.04*faixa,uNeckY+0.06*faixa,hgt);
          objectNormal = normalize(mix(objectNormal, girar(objectNormal,0.0,uHead), wHead)); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime,uInt,uBaseY,uTopY; uniform vec3 uTint; varying float vGap; varying float vYm;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        { // --- holograma ---
          float lum=dot(diffuseColor.rgb,vec3(0.3,0.59,0.11));              // detalhe da textura (placas, cabos, olhos)
          vec3 nv=normalize(normal); vec3 vd=normalize(vViewPosition);
          float fres=pow(1.-abs(dot(nv,vd)),2.2);                            // bordas e contornos acesos
          float frac=(vYm-uBaseY)/max(uTopY-uBaseY,1e-4);
          float scan=0.82+0.18*sin(frac*140.-uTime*2.0);                      // varredura horizontal subindo
          float flick=0.97+0.03*sin(uTime*23.0)*sin(uTime*7.3);
          float bright=0.10+0.55*lum+0.85*fres+1.6*smoothstep(0.7,1.0,lum);
          gl_FragColor.rgb=uTint*bright*scan*flick*uInt*(1.-0.85*clamp(vGap,0.,1.));
          gl_FragColor.a=1.0; }`);
  };
  m.needsUpdate = true;
}
function aplicarCal() {
  const L = MODEL.local; if (!L) return;
  const H = L.h1 - L.h0;
  UNI.uMouthY.value = L.h0 + H * CAL.bocaY; UNI.uMouthR.value = L.w * CAL.bocaR; UNI.uJaw.value = H * CAL.queixo;
  UNI.uNeckY.value = L.h0 + H * CAL.pescocoY; UNI.uBaseY.value = L.h0; UNI.uTopY.value = L.h1;
}

const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
loader.load('./dominus.glb', gltf => {
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const SC = CAL.alturaCena / size.y;
  root.scale.setScalar(SC); root.position.set(-center.x * SC, -center.y * SC, -center.z * SC);
  head.add(root); root.updateMatrixWorld(true);
  root.traverse(o => { if (o.isMesh) prepararMalha(o); });
  MODEL.pronto = true;
}, undefined, e => console.error('dominus3d: falha ao carregar ./dominus.glb', e));

/* ---------- boca ---------- */
const VSH = { a: [0.9, 0.3, 0], e: [0.5, 0.75, 0], i: [0.3, 1, 0], o: [0.65, 0, 0.8], u: [0.35, 0, 1] };
const deacc = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const mouth = { cur: new THREE.Vector3(), tgt: new THREE.Vector3() };
let HB = null, NO_AR = false;
function vogalEm(texto, frac) {
  const s = deacc(String(texto || '').toLowerCase()); if (!s.length) return VSH.a;
  const i = Math.min(s.length - 1, Math.floor(frac * s.length));
  for (let k = 0; k < 6; k++) { const c = s[i + k]; if (c && 'aeiou'.includes(c)) return VSH[c]; }
  return VSH.e;
}
function alvoBoca(nowS, t) {
  if (!NO_AR || !HB) return [0, 0, 0];
  const f = HB.fala;
  if (f && f.env && f.env.length && f.dur > 0) {
    const tt = nowS - f.t0;
    if (tt < 0 || tt > f.dur + 0.1) return [0, 0, 0];
    const i = clamp(Math.floor(tt / f.dur * f.env.length), 0, f.env.length - 1);
    const amp = clamp(f.env[i] * 1.25, 0, 1), sh = vogalEm(f.texto, tt / f.dur);
    return [amp * sh[0], amp * sh[1] * 0.8, amp * sh[2] * 0.8];
  }
  // Sem envelope, boca FECHADA - mesmo em estado 'falando'. O estado liga antes de a primeira frase ser
  // sintetizada (1-3 s no Supertonic) e entre frases; a cadencia estimada que havia aqui fazia a boca mexer
  // muito antes de a voz sair (reclamacao do Ugor, 06/10). Agora so o audio real abre a boca.
  return [0, 0, 0];
}

/* ---------- movimento humano ----------
   Cabeça: deriva lenta em três eixos com períodos irracionais (nunca repete), micro-ajustes a cada 6–12 s,
   segue o mouse com atraso, volta ao centro em 10 s. Tronco: balanço menor e mais lento, respiração ~4 s com
   período ruidoso. Estados: ouvindo = inclina um pouco para frente e quieta; pensando = olha para cima/lado e
   oscila; falando = acenos curtos acompanhando a abertura da boca. */
const capa = canvas.parentElement;
let raf = null, ultimo = 0, t0 = performance.now(), W = 0, H = 0;
let mx = 0, my = 0, cx = 0, cy = 0, ultMouse = 0;
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const headCur = new THREE.Vector3(), headTgt = new THREE.Vector3(), torsoCur = new THREE.Vector3();
let micro = new THREE.Vector3(), microAte = 0, proxMicro = 6;
window.addEventListener('mousemove', e => {
  const r = capa.getBoundingClientRect();
  mx = clamp((e.clientX - (r.left + r.width / 2)) / (innerWidth / 2), -1, 1);
  my = clamp((e.clientY - (r.top + r.height / 2)) / (innerHeight / 2), -1, 1);
  ultMouse = performance.now();
}, { passive: true });
const COR = { parado: '#3ee6ff', ouvindo: '#3ee6ff', pensando: '#ffb454', falando: '#3ee6ff' };   // ciano do painel (rgba 62,230,255), nao verde-agua: o Ugor reclamou do verde em 06/10
const tint = new THREE.Color('#3ee6ff'), tintAlvo = new THREE.Color('#3ee6ff');
function ajustar() {
  const r = capa.getBoundingClientRect(), w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height));
  if (w === W && h === H) return; W = w; H = h;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
function quadro(now) {
  raf = requestAnimationFrame(quadro);
  if (now - ultimo < 33) return;
  const dt = Math.min(0.1, ultimo ? (now - ultimo) / 1000 : 0.033); ultimo = now;
  const t = (now - t0) / 1000;
  ajustar();
  const est = NO_AR && HB ? (HB.estado || (HB.falando ? 'falando' : 'parado')) : 'parado';
  tintAlvo.set(COR[est] || COR.parado); tint.lerp(tintAlvo, 1 - Math.exp(-dt * 3));
  UNI.uTint.value.copy(tint); UNI.uTintMix.value += ((est === 'pensando' ? 0.6 : 0) - UNI.uTintMix.value) * (1 - Math.exp(-dt * 3));
  UNI.uTime.value = t; UNI.uInt.value = est === 'ouvindo' ? 1 + 0.25 * (HB && +HB.nivel || 0) : 1;
  // boca
  const m = alvoBoca(Date.now() / 1000, t); mouth.tgt.set(m[0], m[1], m[2]);
  mouth.cur.lerp(mouth.tgt, 1 - Math.exp(-dt * 18)); UNI.uMouth.value.copy(mouth.cur);
  // mouse
  if (now - ultMouse > 10000) { mx = 0; my = 0; }
  cx += (mx - cx) * 0.06; cy += (my - cy) * 0.06;
  // micro-ajustes
  if (t > proxMicro) { micro.set((rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.03); microAte = t + 0.6; proxMicro = t + 6 + rnd() * 6; }
  if (t > microAte) micro.multiplyScalar(1 - Math.min(1, dt * 1.5));
  // cabeça (yaw, pitch, roll) — deriva com períodos irracionais
  let yaw = 0.07 * Math.sin(t * 0.231) + 0.03 * Math.sin(t * 0.517 + 1.3) + cx * 0.42 + micro.x;
  let pitch = 0.035 * Math.sin(t * 0.173 + 0.7) + cy * 0.2 + micro.y;
  let roll = 0.02 * Math.sin(t * 0.139 + 2.1) + micro.z;
  if (est === 'ouvindo') { pitch += 0.06; yaw *= 0.4; }
  if (est === 'pensando') { pitch -= 0.08 + 0.03 * Math.sin(t * 0.9); yaw += 0.12 * Math.sin(t * 0.45); }
  if (est === 'falando') { pitch += 0.05 * mouth.cur.x; yaw += 0.03 * Math.sin(t * 2.1) * mouth.cur.x; }
  headTgt.set(yaw, pitch, roll); headCur.lerp(headTgt, 1 - Math.exp(-dt * 4)); UNI.uHead.value.copy(headCur);
  // tronco: balanço menor, mais lento, parcialmente oposto à cabeça
  torsoCur.set(0.02 * Math.sin(t * 0.11) + cx * 0.08 - headCur.x * 0.12, 0.012 * Math.sin(t * 0.097 + 1) + cy * 0.04, 0.01 * Math.sin(t * 0.083));
  UNI.uTorso.value.copy(torsoCur);
  // respiração com período ruidoso (~4 s), mais rápida quando fala
  const periodo = 4 + 0.5 * Math.sin(t * 0.13) - (est === 'falando' ? 0.8 : 0);
  UNI.uBreath.value = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / periodo);
  head.position.y = 0.006 * Math.sin(t * 2 * Math.PI / periodo);
  renderer.render(scene, camera);
}
function iniciar() { if (raf || document.hidden) return; ultimo = 0; raf = requestAnimationFrame(quadro); }
function parar() { if (raf) cancelAnimationFrame(raf); raf = null; }
document.addEventListener('visibilitychange', () => { if (document.hidden) parar(); else iniciar(); });
iniciar();

window.DOMINUS_3D = {
  voz(hb, noAr) { HB = hb || null; NO_AR = !!noAr; },
  setMouth({ open = 0, wide = 0, round = 0 } = {}) { HB = { estado: 'parado', fala: { t0: Date.now() / 1000, dur: 2, texto: 'a', env: new Array(50).fill(open) } }; NO_AR = true; mouth.tgt.set(open, wide, round); },
  calibrar(o = {}) { Object.assign(CAL, o); aplicarCal(); return { ...CAL }; },   // ex.: DOMINUS_3D.calibrar({bocaY:.8})
  pronto: () => MODEL.pronto,
  CAL, UNI, head, camera, renderer, scene,
};
