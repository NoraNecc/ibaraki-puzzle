import "./style.css";
import { geoMercator, geoPath } from "d3-geo";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  MultiPolygon,
  Position,
  Polygon,
} from "geojson";

type Geometry = Polygon | MultiPolygon;

type MunicipalityCollection = FeatureCollection<
  Geometry,
  GeoJsonProperties
>;

type MunicipalityFeature = Feature<
  Geometry,
  GeoJsonProperties
>;

type PuzzlePiece = {
  id: string;
  name: string;
  pathData: string;
  centroidX: number;
  centroidY: number;
  offsetX: number;
  offsetY: number;
  activated: boolean;
  placed: boolean;
  pathElement: SVGPathElement | null;
  buttonElement: HTMLButtonElement | null;
};

type DragState = {
  piece: PuzzlePiece;
  pointerId: number;
  startPointerX: number;
  startPointerY: number;
  startOffsetX: number;
  startOffsetY: number;
};

type LinearRing = Position[];

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SNAP_DISTANCE = 28;
const WORKSPACE_CENTER_X = 115;
const WORKSPACE_MIN_Y = 90;
const WORKSPACE_MAX_Y = 730;

function queryRequiredElement<T extends Element>(
  selector: string,
): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(
      "index.html内に必要な要素が見つかりません。",
    );
  }

  return element;
}

const mapElement =
  queryRequiredElement<SVGSVGElement>("#map");
const targetLayer =
  queryRequiredElement<SVGGElement>("#target-layer");
const pieceLayer =
  queryRequiredElement<SVGGElement>("#piece-layer");
const pieceTray =
  queryRequiredElement<HTMLDivElement>("#piece-tray");
const placedCountElement =
  queryRequiredElement<HTMLSpanElement>(
    "#placed-count",
  );
const totalCountElement =
  queryRequiredElement<HTMLSpanElement>(
    "#total-count",
  );
const timerElement =
  queryRequiredElement<HTMLElement>("#timer");
const resetButton =
  queryRequiredElement<HTMLButtonElement>(
    "#reset-button",
  );
const messageElement =
  queryRequiredElement<HTMLParagraphElement>(
    "#message",
  );

const pieces = new Map<string, PuzzlePiece>();

let dragState: DragState | null = null;
let placedCount = 0;
let timerStarted = false;
let timerFinished = false;
let timerStart = 0;
let elapsedMilliseconds = 0;
let timerIntervalId: number | null = null;

function signedRingArea(ring: LinearRing): number {
  let area = 0;

  for (
    let index = 0, previousIndex = ring.length - 1;
    index < ring.length;
    previousIndex = index, index += 1
  ) {
    const [previousX, previousY] =
      ring[previousIndex];
    const [currentX, currentY] = ring[index];

    area +=
      previousX * currentY -
      currentX * previousY;
  }

  return area / 2;
}

function orientRing(
  ring: LinearRing,
  shouldBeClockwise: boolean,
): LinearRing {
  const nextRing = ring.map(
    (position) => position.slice() as Position,
  );
  const isClockwise = signedRingArea(ring) < 0;

  if (isClockwise !== shouldBeClockwise) {
    nextRing.reverse();
  }

  return nextRing;
}

function rewindPolygonCoordinates(
  coordinates: Polygon["coordinates"],
): Polygon["coordinates"] {
  return coordinates.map((ring, index) =>
    orientRing(ring, index === 0),
  );
}

function rewindGeometryForD3(
  geometry: Geometry,
): Geometry {
  if (geometry.type === "Polygon") {
    return {
      ...geometry,
      coordinates: rewindPolygonCoordinates(
        geometry.coordinates,
      ),
    };
  }

  return {
    ...geometry,
    coordinates: geometry.coordinates.map(
      rewindPolygonCoordinates,
    ),
  };
}

function rewindCollectionForD3(
  collection: MunicipalityCollection,
): MunicipalityCollection {
  return {
    ...collection,
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: rewindGeometryForD3(feature.geometry),
    })),
  };
}

function getProperty(
  properties: GeoJsonProperties,
  lowerName: string,
  upperName: string,
): string {
  if (!properties) {
    throw new Error("propertiesがありません。");
  }

  const value =
    properties[lowerName] ?? properties[upperName];

  if (value === undefined || value === null) {
    console.error("実際のproperties:", properties);
    throw new Error(
      `${lowerName}または${upperName}がありません。`,
    );
  }

  return String(value);
}

async function initializeGame(): Promise<void> {
  setMessage("地図データを読み込んでいます。");

  const response = await fetch(
    `${import.meta.env.BASE_URL}data/ibaraki_municipalities.geojson`,
  );

  if (!response.ok) {
    throw new Error(
      `GeoJSONを読み込めませんでした。HTTP ${response.status}`,
    );
  }

  const rawCollection =
    (await response.json()) as MunicipalityCollection;

  if (
    rawCollection.type !== "FeatureCollection" ||
    rawCollection.features.length === 0
  ) {
    throw new Error(
      "GeoJSONが正しいFeatureCollectionではありません。",
    );
  }

  const collection =
    rewindCollectionForD3(rawCollection);

  const projection = geoMercator().fitExtent(
    [
      [270, 35],
      [965, 765],
    ],
    collection,
  );

  const pathGenerator = geoPath(projection);

  targetLayer.replaceChildren();
  pieceLayer.replaceChildren();
  pieceTray.replaceChildren();
  pieces.clear();

  for (const feature of collection.features) {
    createMunicipality(feature, pathGenerator);
  }

  totalCountElement.textContent =
    String(pieces.size);

  resetGame();
}

function createMunicipality(
  feature: MunicipalityFeature,
  pathGenerator: ReturnType<typeof geoPath>,
): void {
  const id = getProperty(
  feature.properties,
  "N03_007",
  "N03_007",
);

const name = getProperty(
  feature.properties,
  "N03_004",
  "N03_004",
);

  const pathData = pathGenerator(feature);
  const [centroidX, centroidY] =
    pathGenerator.centroid(feature);

  if (
    !pathData ||
    !Number.isFinite(centroidX) ||
    !Number.isFinite(centroidY)
  ) {
    console.warn(`${name}を描画できませんでした。`);
    return;
  }

  createTargetPath(id, name, pathData);

  const piece: PuzzlePiece = {
    id,
    name,
    pathData,
    centroidX,
    centroidY,
    offsetX: 0,
    offsetY: 0,
    activated: false,
    placed: false,
    pathElement: null,
    buttonElement: null,
  };

  pieces.set(id, piece);
  createPieceButton(piece);
}

function createTargetPath(
  id: string,
  name: string,
  pathData: string,
): void {
  const target = document.createElementNS(
    SVG_NAMESPACE,
    "path",
  );

  target.setAttribute("d", pathData);
  target.setAttribute("class", "target-piece");
  target.dataset.id = id;
  target.setAttribute(
    "aria-label",
    `${name}の正解位置`,
  );

  targetLayer.appendChild(target);
}

function createPieceButton(
  piece: PuzzlePiece,
): void {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "piece-button";
  button.textContent = piece.name;

  button.addEventListener("click", () => {
    activatePiece(piece);
  });

  piece.buttonElement = button;
  pieceTray.appendChild(button);
}

function activatePiece(piece: PuzzlePiece): void {
  if (piece.placed) {
    return;
  }

  startTimer();

  if (!piece.activated) {
    piece.activated = true;
    createDraggablePath(piece);
    movePieceToWorkspace(piece);
  }

  bringPieceToFront(piece);
  highlightButton(piece);

  setMessage(
    `${piece.name}を正しい位置へドラッグしてください。`,
  );
}

function createDraggablePath(
  piece: PuzzlePiece,
): void {
  const path = document.createElementNS(
    SVG_NAMESPACE,
    "path",
  );

  path.setAttribute("d", piece.pathData);
  path.setAttribute("class", "puzzle-piece");
  path.dataset.id = piece.id;

  path.addEventListener(
    "pointerdown",
    (event: PointerEvent) => {
      beginDrag(event, piece);
    },
  );

  piece.pathElement = path;
  pieceLayer.appendChild(path);
}

function movePieceToWorkspace(
  piece: PuzzlePiece,
): void {
  const randomY =
    WORKSPACE_MIN_Y +
    Math.random() *
      (WORKSPACE_MAX_Y - WORKSPACE_MIN_Y);

  piece.offsetX =
    WORKSPACE_CENTER_X - piece.centroidX;

  piece.offsetY =
    randomY - piece.centroidY;

  updateTransform(piece);
}

function beginDrag(
  event: PointerEvent,
  piece: PuzzlePiece,
): void {
  if (piece.placed || !piece.pathElement) {
    return;
  }

  event.preventDefault();
  startTimer();
  bringPieceToFront(piece);
  highlightButton(piece);

  const pointer = clientToSvg(
    event.clientX,
    event.clientY,
  );

  dragState = {
    piece,
    pointerId: event.pointerId,
    startPointerX: pointer.x,
    startPointerY: pointer.y,
    startOffsetX: piece.offsetX,
    startOffsetY: piece.offsetY,
  };

  piece.pathElement.classList.add("dragging");
  piece.pathElement.setPointerCapture(
    event.pointerId,
  );

  piece.pathElement.addEventListener(
    "pointermove",
    moveDrag,
  );

  piece.pathElement.addEventListener(
    "pointerup",
    endDrag,
  );

  piece.pathElement.addEventListener(
    "pointercancel",
    endDrag,
  );
}

function moveDrag(event: PointerEvent): void {
  if (
    !dragState ||
    event.pointerId !== dragState.pointerId
  ) {
    return;
  }

  const pointer = clientToSvg(
    event.clientX,
    event.clientY,
  );

  dragState.piece.offsetX =
    dragState.startOffsetX +
    pointer.x -
    dragState.startPointerX;

  dragState.piece.offsetY =
    dragState.startOffsetY +
    pointer.y -
    dragState.startPointerY;

  updateTransform(dragState.piece);
}

function endDrag(event: PointerEvent): void {
  if (
    !dragState ||
    event.pointerId !== dragState.pointerId
  ) {
    return;
  }

  const piece = dragState.piece;
  const path = piece.pathElement;

  if (path) {
    path.classList.remove("dragging");

    if (path.hasPointerCapture(event.pointerId)) {
      path.releasePointerCapture(event.pointerId);
    }

    path.removeEventListener(
      "pointermove",
      moveDrag,
    );

    path.removeEventListener(
      "pointerup",
      endDrag,
    );

    path.removeEventListener(
      "pointercancel",
      endDrag,
    );
  }

  dragState = null;
  judgePosition(piece);
}

function judgePosition(piece: PuzzlePiece): void {
  const distance =
    Math.hypot(piece.offsetX, piece.offsetY);

  if (distance <= SNAP_DISTANCE) {
    placeCorrectly(piece);
  } else {
    setMessage(
      `${piece.name}はまだ正しい位置ではありません。`,
      "error",
    );
  }
}

function placeCorrectly(
  piece: PuzzlePiece,
): void {
  if (piece.placed || !piece.pathElement) {
    return;
  }

  piece.offsetX = 0;
  piece.offsetY = 0;
  piece.placed = true;

  updateTransform(piece);
  piece.pathElement.classList.add("placed");

  if (piece.buttonElement) {
    piece.buttonElement.disabled = true;
    piece.buttonElement.classList.remove("active");
    piece.buttonElement.textContent =
      `✓ ${piece.name}`;
  }

  placedCount += 1;
  updatePlacedCount();

  if (placedCount === pieces.size) {
    finishGame();
    return;
  }

  setMessage(
    `${piece.name}が正解です。残り${pieces.size - placedCount}市町村です。`,
    "success",
  );
}

function updateTransform(
  piece: PuzzlePiece,
): void {
  piece.pathElement?.setAttribute(
    "transform",
    `translate(${piece.offsetX} ${piece.offsetY})`,
  );
}

function bringPieceToFront(
  piece: PuzzlePiece,
): void {
  if (piece.pathElement) {
    pieceLayer.appendChild(piece.pathElement);
  }
}

function highlightButton(
  activePiece: PuzzlePiece,
): void {
  for (const piece of pieces.values()) {
    piece.buttonElement?.classList.toggle(
      "active",
      piece.id === activePiece.id &&
        !activePiece.placed,
    );
  }
}

function clientToSvg(
  clientX: number,
  clientY: number,
): DOMPoint {
  const matrix =
    mapElement.getScreenCTM()?.inverse();

  if (!matrix) {
    throw new Error(
      "SVG座標へ変換できませんでした。",
    );
  }

  return new DOMPoint(
    clientX,
    clientY,
  ).matrixTransform(matrix);
}

function updatePlacedCount(): void {
  placedCountElement.textContent =
    String(placedCount);
}

function startTimer(): void {
  if (timerStarted || timerFinished) {
    return;
  }

  timerStarted = true;
  timerStart = performance.now();

  timerIntervalId = window.setInterval(() => {
    updateTimer();
  }, 100);
}

function currentElapsed(): number {
  if (!timerStarted) {
    return elapsedMilliseconds;
  }

  return (
    elapsedMilliseconds +
    performance.now() -
    timerStart
  );
}

function updateTimer(): void {
  const totalSeconds = Math.floor(
    currentElapsed() / 1000,
  );

  const minutes =
    Math.floor(totalSeconds / 60);

  const seconds =
    totalSeconds % 60;

  timerElement.textContent =
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}`;
}

function stopTimer(): void {
  if (!timerStarted) {
    return;
  }

  elapsedMilliseconds = currentElapsed();
  timerStarted = false;

  if (timerIntervalId !== null) {
    window.clearInterval(timerIntervalId);
    timerIntervalId = null;
  }

  updateTimer();
}

function finishGame(): void {
  stopTimer();
  timerFinished = true;

  setMessage(
    `完成です。記録は${timerElement.textContent}でした。`,
    "success",
  );
}

function resetGame(): void {
  dragState = null;
  placedCount = 0;
  updatePlacedCount();
  resetTimer();

  for (const piece of pieces.values()) {
    piece.activated = false;
    piece.placed = false;
    piece.offsetX = 0;
    piece.offsetY = 0;

    piece.pathElement?.remove();
    piece.pathElement = null;

    if (piece.buttonElement) {
      piece.buttonElement.disabled = false;
      piece.buttonElement.classList.remove("active");
      piece.buttonElement.textContent =
        piece.name;
    }
  }

  setMessage(
    "下の一覧から市町村を選択してください。",
  );
}

function resetTimer(): void {
  if (timerIntervalId !== null) {
    window.clearInterval(timerIntervalId);
  }

  timerIntervalId = null;
  timerStarted = false;
  timerFinished = false;
  timerStart = 0;
  elapsedMilliseconds = 0;

  updateTimer();
}

function setMessage(
  text: string,
  kind?: "success" | "error",
): void {
  messageElement.textContent = text;
  messageElement.classList.remove(
    "success",
    "error",
  );

  if (kind) {
    messageElement.classList.add(kind);
  }
}

resetButton.addEventListener("click", () => {
  resetGame();
});

initializeGame().catch((error: unknown) => {
  console.error(error);

  const message =
    error instanceof Error
      ? error.message
      : "不明なエラーが発生しました。";

  setMessage(message, "error");
});
