import './styles.css';
import JSZip from 'jszip';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const clayPalette = ['#e6d4c5', '#d9c1b1', '#d0d7cf', '#c8d5df', '#e3cfb8'];

const canvas = document.querySelector('#scan-canvas');
const loadingOverlay = document.querySelector('#loading-overlay');
const loadingLabel = document.querySelector('#loading-label');
const statsEl = document.querySelector('#mesh-stats');
const modelListEl = document.querySelector('#model-list');
const scanSourceEl = document.querySelector('#scan-source');
const zipUploadEl = document.querySelector('#zip-upload');
const galleryStrip = document.querySelector('.gallery-strip');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const viewButtons = [...document.querySelectorAll('[data-view]')];
const rotationInputs = {
  x: document.querySelector('#rotate-x'),
  y: document.querySelector('#rotate-y'),
  z: document.querySelector('#rotate-z')
};

const scene = new THREE.Scene();
scene.background = new THREE.Color('#11100f');

const renderer = createRenderer();

const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, -160, 95);

const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 3.2;
controls.zoomSpeed = 1.2;
controls.panSpeed = 0.7;
controls.dynamicDampingFactor = 0.09;
controls.minDistance = 15;
controls.maxDistance = 900;

const scanGroup = new THREE.Group();
scene.add(scanGroup);

const fillLight = new THREE.HemisphereLight('#ffffff', '#5b4a42', 0.9);
scene.add(fillLight);

const keyLight = new THREE.DirectionalLight('#fff4ea', 1.25);
keyLight.position.set(90, -120, 160);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight('#8edbd2', 0.45);
rimLight.position.set(-120, 90, 80);
scene.add(rimLight);

const plyLoader = new PLYLoader();
const stlLoader = new STLLoader();

let activeMeshes = [];
let currentMode = 'vertex';
let bounds = null;
let galleryObjectUrls = [];
let overlayTimer = null;

init();

function init() {
  bindControls();
  showEmptyState();
  animate();
}

async function replaceScan({ label, meshes, gallery = [], ownedGalleryUrls = [] }) {
  showLoading('Loading scan');

  const loadedMeshes = [];

  try {
    for (let index = 0; index < meshes.length; index += 1) {
      showLoading(`Loading ${meshes[index].label}`);
      loadedMeshes.push(await loadMesh(meshes[index], index));
    }
  } catch (error) {
    loadedMeshes.forEach(disposeMesh);
    throw error;
  }

  clearCurrentMeshes();

  activeMeshes = loadedMeshes;
  activeMeshes.forEach((mesh) => scanGroup.add(mesh));
  scanSourceEl.textContent = label;

  resetRotation();
  normalizeModel();
  applyMode(currentMode);
  updateModelControls();
  updateStats();
  updateGallery(gallery, ownedGalleryUrls);
  frameScan('front');
  hideLoading();
}

async function loadMesh(asset, index) {
  const geometry =
    asset.arrayBuffer instanceof ArrayBuffer
      ? parseGeometry(asset.arrayBuffer, asset.format)
      : await loadGeometryFromUrl(asset.meshUrl, asset.format);

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.62,
    metalness: 0,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = asset.label;
  mesh.userData = {
    id: asset.id,
    label: asset.label,
    source: asset.format.toUpperCase(),
    hasColor: Boolean(geometry.attributes.color),
    vertices: geometry.attributes.position?.count ?? 0,
    faces: getFaceCount(geometry),
    clayColor: asset.clayColor ?? clayPalette[index % clayPalette.length]
  };

  return mesh;
}

function parseGeometry(arrayBuffer, format) {
  if (format === 'ply') {
    return plyLoader.parse(arrayBuffer);
  }

  if (format === 'stl') {
    return stlLoader.parse(arrayBuffer);
  }

  throw new Error(`Unsupported mesh format: ${format}`);
}

function loadGeometryFromUrl(url, format) {
  if (format === 'ply') {
    return plyLoader.loadAsync(url);
  }

  if (format === 'stl') {
    return stlLoader.loadAsync(url);
  }

  throw new Error(`Unsupported mesh format: ${format}`);
}

async function loadZipFile(file) {
  showLoading(`Reading ${file.name}`);

  const zip = await JSZip.loadAsync(file);
  const meshEntries = Object.values(zip.files).filter(isMeshEntry);

  if (meshEntries.length === 0) {
    throw new Error('No PLY or STL files were found in that ZIP.');
  }

  const selectedMeshes = selectMeshEntries(meshEntries);
  const meshAssets = [];

  for (let index = 0; index < selectedMeshes.length; index += 1) {
    const selection = selectedMeshes[index];
    showLoading(`Unpacking ${selection.label}`);
    meshAssets.push({
      id: selection.id,
      label: selection.label,
      format: selection.format,
      arrayBuffer: await selection.entry.async('arraybuffer'),
      clayColor: clayPalette[index % clayPalette.length]
    });
  }

  const { gallery, urls } = await createGalleryFromZip(zip);
  const label = cleanScanLabel(file.name);

  try {
    await replaceScan({
      label,
      meshes: meshAssets,
      gallery,
      ownedGalleryUrls: urls
    });
  } catch (error) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
}

function selectMeshEntries(entries) {
  const groups = new Map();

  entries.forEach((entry) => {
    const format = getMeshFormat(entry.name);
    const jawKey = inferJawKey(entry.name);
    const key = jawKey ?? getFileStem(entry.name);
    const existing = groups.get(key);

    if (!existing || meshFormatScore(format) > meshFormatScore(existing.format)) {
      groups.set(key, {
        entry,
        format,
        id: slugify(key),
        label: jawKey ? toTitleCase(jawKey) : toTitleCase(getFileStem(entry.name))
      });
    }
  });

  return [...groups.values()].sort((a, b) => {
    const order = { upper: 0, lower: 1 };
    const aOrder = order[a.id] ?? 10;
    const bOrder = order[b.id] ?? 10;

    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.label.localeCompare(b.label);
  });
}

async function createGalleryFromZip(zip) {
  const imageEntries = Object.values(zip.files)
    .filter(isGalleryImageEntry)
    .sort((a, b) => imageRank(a.name) - imageRank(b.name) || a.name.localeCompare(b.name))
    .slice(0, 3);

  const urls = [];
  const gallery = [];

  for (const entry of imageEntries) {
    const blob = await entry.async('blob');
    const url = URL.createObjectURL(blob);
    urls.push(url);
    gallery.push({ src: url, alt: toTitleCase(getFileStem(entry.name)) });
  }

  return { gallery, urls };
}

function normalizeModel() {
  scanGroup.position.set(0, 0, 0);
  scanGroup.scale.set(1, 1, 1);

  bounds = new THREE.Box3().setFromObject(scanGroup);
  const center = bounds.getCenter(new THREE.Vector3());
  scanGroup.position.set(-center.x, -center.y, -center.z);

  bounds = new THREE.Box3().setFromObject(scanGroup);
  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  if (maxDim > 0) {
    scanGroup.scale.setScalar(100 / maxDim);
  }

  bounds = new THREE.Box3().setFromObject(scanGroup);
}

function applyMode(mode) {
  currentMode = mode;

  activeMeshes.forEach((mesh) => {
    const { hasColor, clayColor } = mesh.userData;
    const material = mesh.material;
    const useVertexColor = mode === 'vertex' && hasColor;

    material.map = null;
    material.vertexColors = useVertexColor;
    material.color.set(useVertexColor ? '#ffffff' : clayColor);
    material.roughness = mode === 'clay' ? 0.74 : 0.62;
    material.needsUpdate = true;
  });

  modeButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === mode);
  });
}

function frameScan(view = 'front') {
  if (!bounds) return;

  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = (maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * 1.45;
  const direction = getViewDirection(view);

  camera.up.set(0, 0, 1);
  camera.position.copy(center).add(direction.multiplyScalar(distance));
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.handleResize();
  controls.update();
}

function getViewDirection(view) {
  const directions = {
    front: new THREE.Vector3(0, -1, 0.18),
    upper: new THREE.Vector3(0, 0, 1),
    lower: new THREE.Vector3(0, 0, -1),
    left: new THREE.Vector3(-1, -0.04, 0.12),
    right: new THREE.Vector3(1, -0.04, 0.12)
  };

  return (directions[view] ?? directions.front).clone().normalize();
}

function bindControls() {
  zipUploadEl.addEventListener('change', async (event) => {
    const uploadInput = event.currentTarget;
    const [file] = uploadInput.files;
    if (!file) return;

    uploadInput.disabled = true;

    try {
      await loadZipFile(file);
    } catch (error) {
      console.error(error);
      showError(error.message || 'That ZIP could not be loaded.', true);
    } finally {
      uploadInput.value = '';
      uploadInput.disabled = false;
    }
  });

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => applyMode(button.dataset.mode));
  });

  viewButtons.forEach((button) => {
    button.addEventListener('click', () => frameScan(button.dataset.view));
  });

  Object.values(rotationInputs).forEach((input) => {
    input.addEventListener('input', updateModelRotation);
  });

  document.querySelector('#reset-rotation').addEventListener('click', resetRotation);
  document.querySelector('#reset-view').addEventListener('click', () => frameScan('front'));

  document.querySelector('#capture-view').addEventListener('click', () => {
    renderer.render(scene, camera);
    const link = document.createElement('a');
    link.download = 'teeth-scan-view.png';
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();
  });

  document.querySelector('#key-light').addEventListener('input', (event) => {
    keyLight.intensity = Number(event.currentTarget.value);
  });

  document.querySelector('#ambient-light').addEventListener('input', (event) => {
    fillLight.intensity = Number(event.currentTarget.value);
  });
}

function updateModelControls() {
  modelListEl.innerHTML = '';

  activeMeshes.forEach((mesh) => {
    const label = document.createElement('label');
    const text = document.createElement('span');
    const input = document.createElement('input');

    label.className = 'toggle-row';
    text.textContent = mesh.userData.label;
    input.type = 'checkbox';
    input.checked = mesh.visible;
    input.addEventListener('change', (event) => {
      mesh.visible = event.currentTarget.checked;
    });

    label.append(text, input);
    modelListEl.append(label);
  });
}

function updateStats() {
  statsEl.innerHTML = '';

  activeMeshes.forEach((mesh) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');

    term.textContent = mesh.userData.label;
    detail.textContent = `${formatCount(mesh.userData.vertices)} vertices / ${formatCount(mesh.userData.faces)} faces / ${mesh.userData.source}`;
    row.append(term, detail);
    statsEl.append(row);
  });
}

function updateGallery(gallery, ownedGalleryUrls = []) {
  galleryObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  galleryObjectUrls = ownedGalleryUrls;
  galleryStrip.innerHTML = '';
  galleryStrip.classList.toggle('is-hidden', gallery.length === 0);

  gallery.forEach((image) => {
    const img = document.createElement('img');
    img.src = image.src;
    img.alt = image.alt;
    galleryStrip.append(img);
  });
}

function showEmptyState() {
  clearCurrentMeshes();
  resetRotation();
  scanSourceEl.textContent = 'Upload Mode';
  modelListEl.innerHTML = '<p class="empty-copy">No scan loaded</p>';
  statsEl.innerHTML = '<div><dt>Status</dt><dd>Upload a ZIP</dd></div>';
  updateGallery([]);
  hideLoading();
}

function updateModelRotation() {
  scanGroup.rotation.set(
    THREE.MathUtils.degToRad(Number(rotationInputs.x.value)),
    THREE.MathUtils.degToRad(Number(rotationInputs.y.value)),
    THREE.MathUtils.degToRad(Number(rotationInputs.z.value)),
    'XYZ'
  );
}

function resetRotation() {
  rotationInputs.x.value = '0';
  rotationInputs.y.value = '0';
  rotationInputs.z.value = '0';
  scanGroup.rotation.set(0, 0, 0);
}

function clearCurrentMeshes() {
  activeMeshes.forEach((mesh) => {
    scanGroup.remove(mesh);
    disposeMesh(mesh);
  });

  activeMeshes = [];
  bounds = null;
}

function disposeMesh(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

function showLoading(message) {
  clearTimeout(overlayTimer);
  loadingOverlay.classList.remove('is-hidden', 'is-error');
  loadingLabel.textContent = message;
}

function hideLoading() {
  clearTimeout(overlayTimer);
  loadingOverlay.classList.add('is-hidden');
}

function showError(message, temporary) {
  clearTimeout(overlayTimer);
  loadingOverlay.classList.remove('is-hidden');
  loadingOverlay.classList.add('is-error');
  loadingLabel.textContent = message;

  if (temporary) {
    overlayTimer = window.setTimeout(() => {
      loadingOverlay.classList.add('is-hidden');
    }, 3200);
  }
}

function isMeshEntry(entry) {
  return !entry.dir && !entry.name.includes('__MACOSX/') && /\.(ply|stl)$/i.test(entry.name);
}

function isGalleryImageEntry(entry) {
  if (entry.dir || entry.name.includes('__MACOSX/')) return false;
  if (!/\.(jpe?g|png|webp)$/i.test(entry.name)) return false;

  const normalized = entry.name.toLowerCase();
  return !normalized.includes('texture') && !normalized.includes('logo');
}

function imageRank(name) {
  const normalized = name.toLowerCase();
  if (normalized.includes('front')) return 0;
  if (normalized.includes('upper')) return 1;
  if (normalized.includes('lower')) return 2;
  if (normalized.includes('left')) return 3;
  if (normalized.includes('right')) return 4;
  return 5;
}

function inferJawKey(path) {
  const stem = getFileStem(path).toLowerCase();

  if (/(^|[_\-\s])(u|upper|maxilla|maxillary)($|[_\-\s])/.test(stem)) {
    return 'upper';
  }

  if (/(^|[_\-\s])(l|lower|mandible|mandibular)($|[_\-\s])/.test(stem)) {
    return 'lower';
  }

  return null;
}

function getMeshFormat(path) {
  const match = path.toLowerCase().match(/\.(ply|stl)$/);
  return match?.[1] ?? '';
}

function meshFormatScore(format) {
  return format === 'ply' ? 2 : 1;
}

function getFileStem(path) {
  return path
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '');
}

function cleanScanLabel(filename) {
  return filename.replace(/\.[^.]+$/, '') || 'Uploaded Scan';
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || `model-${Date.now()}`;
}

function toTitleCase(value) {
  return value
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getFaceCount(geometry) {
  if (geometry.index) {
    return Math.round(geometry.index.count / 3);
  }

  return Math.round((geometry.attributes.position?.count ?? 0) / 3);
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US', {
    notation: value > 9999 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(value);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  controls.handleResize();
});

function createRenderer() {
  try {
    const webglRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true
    });

    webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    webglRenderer.setSize(window.innerWidth, window.innerHeight);
    webglRenderer.outputColorSpace = THREE.SRGBColorSpace;
    webglRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    webglRenderer.toneMappingExposure = 1.05;

    return webglRenderer;
  } catch (error) {
    loadingOverlay.classList.add('is-error');
    loadingLabel.textContent = 'WebGL is unavailable in this browser.';
    throw error;
  }
}
