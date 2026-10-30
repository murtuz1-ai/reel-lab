"""ИИ-помощник Reel Lab: «как сделан этот ролик» и ответы на вопросы о студии.

Разбор чужого ролика — сначала замеры без ИИ (FFmpeg и немного арифметики):
  • склейки: где меняется кадр, плавные переходы, вспышки белым и затемнения;
  • темп монтажа: сколько планов, какой длины, в долю ли музыки режут;
  • цвет: яркость, контраст, насыщенность, тёплый или холодный, «голливуд»
    (тени бирюзовые, свет оранжевый), ч/б, виньетка, кинополосы;
  • звук: доли музыки и темп, «вжух» на склейках, речь (текст — из распознавания).
Из замеров получается рецепт — те же настройки, что у готовых монтажей студии,
и шаги «как сделать так же в Reel Lab». ИИ (если подключён) смотрит кадры
(какие субтитры, что в кадре) и пересказывает разбор живым языком. Без ИИ
разбор всё равно готов — по замерам.

Модуль без Flask: им пользуются и сервер, и бот.
"""
from __future__ import annotations

import array
import json
import math
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

ANALYSIS_VERSION = 1
MAX_ANALYSE_SECONDS = 180          # разбираем первые 3 минуты
STAT_FPS = 30                      # кадров в секунду для поиска склеек
THUMB_FPS = 4                      # маленьких кадров в секунду: цвет и «тот же ли это план»
THUMB_SIDE = 96
AUDIO_RATE = 100                   # огибающие звука: 100 значений в секунду
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

Progress = Callable[[str, int], None]


class AnalysisError(Exception):
    """Понятная человеку причина, почему ролик не разобрать."""


def _ffmpeg() -> str:
    from speech_cloud import find_ffmpeg  # тот же FFmpeg, что у распознавания (и в сборке для Windows)
    return find_ffmpeg()


def _ffprobe() -> str:
    ffmpeg = Path(_ffmpeg())
    name = "ffprobe.exe" if ffmpeg.suffix.lower() == ".exe" else "ffprobe"
    candidate = ffmpeg.with_name(name)
    return str(candidate) if candidate.is_file() else "ffprobe"


def _run(command: list[str], timeout: float, *, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(command, capture_output=True, timeout=timeout, check=False,
                              cwd=str(cwd) if cwd else None, creationflags=_CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired as error:
        raise AnalysisError("Ролик разбирается слишком долго. Попробуй видео покороче.") from error
    except OSError as error:
        raise AnalysisError("FFmpeg не запустился — без него ролик не разобрать.") from error


def _round(value: float, digits: int = 3) -> float:
    return float(round(float(value), digits))


def _median(values: list[float]) -> float:
    items = sorted(values)
    if not items:
        return 0.0
    middle = len(items) // 2
    return items[middle] if len(items) % 2 else (items[middle - 1] + items[middle]) / 2


# ---------------------------------------------------------------------------
# Видео: параметры, склейки, цвет

def aspect_label(width: int, height: int) -> str:
    if not width or not height:
        return ""
    ratio = width / height
    for label, value in (("9:16", 9 / 16), ("3:4", 3 / 4), ("4:5", 4 / 5), ("1:1", 1.0), ("4:3", 4 / 3), ("16:9", 16 / 9), ("21:9", 21 / 9)):
        if abs(ratio - value) / value < 0.04:
            return label
    return f"{width}×{height}"


def probe_media(path: Path) -> dict[str, Any]:
    done = _run([_ffprobe(), "-v", "error", "-show_entries",
                 "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:stream_tags=rotate",
                 "-of", "json", str(path)], 60)
    try:
        data = json.loads(done.stdout.decode("utf-8", errors="replace") or "{}")
    except ValueError:
        data = {}
    streams = data.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    try:
        duration = float((data.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if done.returncode or not video or not math.isfinite(duration) or duration <= 0:
        raise AnalysisError("Не получилось прочитать это видео. Пришли другой файл (MP4 или MOV).")
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    rotation = 0
    for item in video.get("side_data_list") or []:
        if "rotation" in item:
            try:
                rotation = int(float(item["rotation"]))
            except (TypeError, ValueError):
                pass
    if not rotation:
        try:
            rotation = int(float((video.get("tags") or {}).get("rotate") or 0))
        except (TypeError, ValueError):
            rotation = 0
    if abs(rotation) % 180 == 90:
        width, height = height, width
    fps = 0.0
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = str(video.get(key) or "")
        if "/" in raw:
            top, _, bottom = raw.partition("/")
            try:
                if float(bottom):
                    fps = float(top) / float(bottom)
            except ValueError:
                fps = 0.0
        if 1 <= fps <= 240:
            break
    return {
        "duration": _round(duration), "width": width, "height": height, "aspect": aspect_label(width, height),
        "fps": _round(fps if 1 <= fps <= 240 else 30, 2),
        "has_audio": any(item.get("codec_type") == "audio" for item in streams),
    }


def _thumb_size(width: int, height: int) -> tuple[int, int]:
    if width >= height:
        w, h = THUMB_SIDE, max(2, round(THUMB_SIDE * height / max(1, width) / 2) * 2)
    else:
        w, h = max(2, round(THUMB_SIDE * width / max(1, height) / 2) * 2), THUMB_SIDE
    return w, h


def scan_video(path: Path, meta: dict[str, Any], workdir: Path, limit: float) -> tuple[list[dict[str, float]], list[dict[str, Any]]]:
    """Один проход FFmpeg: замеры каждого кадра (смена кадра, яркость, цвет) и маленькие кадры для цвета."""
    workdir.mkdir(parents=True, exist_ok=True)
    stats = workdir / "frames.txt"
    stats.unlink(missing_ok=True)
    tw, th = _thumb_size(meta["width"], meta["height"])
    graph = (f"[0:v]fps={STAT_FPS},split=2[a][b];"
             f"[a]scale=96:-2:flags=area,signalstats,select='gte(scene\\,0)',metadata=mode=print:file=frames.txt[sa];"
             f"[b]fps={THUMB_FPS},scale={tw}:{th}:flags=area,format=rgb24[sb]")
    done = _run([_ffmpeg(), "-v", "error", "-nostdin", "-t", f"{limit:.3f}", "-i", str(path), "-an", "-sn", "-dn",
                 "-filter_complex", graph, "-map", "[sa]", "-f", "null", "-",
                 "-map", "[sb]", "-f", "rawvideo", "pipe:1"], max(120, limit * 3), cwd=workdir)
    if done.returncode or not stats.is_file():
        tail = done.stderr.decode("utf-8", errors="replace")[-300:]
        raise AnalysisError(f"Не получилось просмотреть кадры видео. {tail}".strip())
    frames: list[dict[str, float]] = []
    current: dict[str, float] | None = None
    keys = {"YAVG": "y", "YLOW": "ylow", "YHIGH": "yhigh", "SATAVG": "sat", "UAVG": "u", "VAVG": "v", "YDIF": "dif"}
    for line in stats.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("frame:"):
            match = re.search(r"pts_time:([0-9.eE+-]+)", line)
            current = {"t": float(match.group(1)) if match else (len(frames) / STAT_FPS), "scene": 0.0}
            frames.append(current)
            continue
        if current is None or "=" not in line:
            continue
        key, _, value = line.partition("=")
        try:
            number = float(value)
        except ValueError:
            continue
        if key == "lavfi.scene_score":
            current["scene"] = number
        elif key.startswith("lavfi.signalstats."):
            name = keys.get(key.rsplit(".", 1)[1])
            if name:
                current[name] = number
    # Яркость в видео обычно «телевизионная» (чёрное = 16, белое = 235): переводим в 0…1.
    full = lambda value: min(1.0, max(0.0, (value - 16) / 219))  # noqa: E731
    for frame in frames:
        frame["y"] = full(frame.get("y", 16.0))
        frame["ylow"] = full(frame.get("ylow", 16.0))
        frame["yhigh"] = full(frame.get("yhigh", 16.0))
        frame["dif"] = frame.get("dif", 0.0) / 219
        frame["sat"] = frame.get("sat", 0.0) / 128
        frame["u"] = (frame.get("u", 128.0) - 128) / 128
        frame["v"] = (frame.get("v", 128.0) - 128) / 128
    size = tw * th * 3
    raw = done.stdout
    thumbs = [{"t": index / THUMB_FPS, "w": tw, "h": th, "data": raw[index * size:(index + 1) * size]}
              for index in range(len(raw) // size)]
    if len(frames) < 3:
        raise AnalysisError("Видео слишком короткое для разбора.")
    return frames, thumbs


def _luma_grid(thumb: dict[str, Any]) -> list[float]:
    """Середина кадра (без полос и тёмных краёв) вдвое мельче — яркость без среднего и разброса:
    так экспозиция и виньетка не мешают сравнивать планы."""
    w, h, data = thumb["w"], thumb["h"], thumb["data"]
    x0, x1 = int(w * 0.15) // 2, int(w * 0.85) // 2
    y0, y1 = int(h * 0.2) // 2, int(h * 0.8) // 2
    out = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            total = 0.0
            for dy in (0, 1):
                base = ((y * 2 + dy) * w + x * 2) * 3
                for dx in (0, 3):
                    o = base + dx
                    total += 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]
            out.append(total / 4)
    mean = sum(out) / max(1, len(out))
    std = math.sqrt(sum((v - mean) ** 2 for v in out) / max(1, len(out))) or 1.0
    return [(v - mean) / std for v in out]


def _ncc(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b)) / max(1, len(a))


def _around(thumbs: list[dict[str, Any]], t: float, gap: float) -> tuple[dict[str, Any], dict[str, Any]] | None:
    before = [item for item in thumbs if t - gap - 0.5 <= item["t"] <= t - gap]
    after = [item for item in thumbs if t + gap <= item["t"] <= t + gap + 0.5]
    if not before or not after or not before[-1]["data"] or len(before[-1]["data"]) != len(after[0]["data"]):
        return None
    return before[-1], after[0]


def _same_scene(thumbs: list[dict[str, Any]], t: float, gap: float = 0.3) -> float | None:
    """Похожи ли кадры до и после момента t (1 — тот же план, около 0 — другой). None — нет кадров."""
    pair = _around(thumbs or [], t, gap)
    return _ncc(_luma_grid(pair[0]), _luma_grid(pair[1])) if pair else None


def find_junctions(frames: list[dict[str, float]], thumbs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Склейки и переходы по замерам кадров.

    cut — резкая смена кадра; white — вспышка белым; black — через чёрное;
    dissolve — один кадр плавно перетекает в другой.
    Оценка смены кадра у FFmpeg (scene) — насколько резко изменилась разница
    между кадрами: склейку видно, а плавное движение камеры — нет. Растворение
    ищется по «пандусу»: цвет и яркость ровно переходят от одного плана к другому.
    """
    n = len(frames)
    scene = [frame["scene"] for frame in frames]
    luma = [frame["y"] for frame in frames]
    step = (frames[-1]["t"] - frames[0]["t"]) / max(1, n - 1) if n > 1 else 1 / STAT_FPS
    step = step if step > 0 else 1 / STAT_FPS
    quiet = sorted(scene)
    base = quiet[int(len(quiet) * 0.6)] if quiet else 0.0
    high = max(0.26, min(0.45, base * 5 + 0.14))
    used = [False] * n
    junctions: list[dict[str, Any]] = []
    frames_in = lambda seconds: max(1, int(round(seconds / step)))  # noqa: E731

    def mark(first: int, last: int) -> None:
        for k in range(max(0, first), min(n, last + 1)):
            used[k] = True

    # 1) Вспышки белым и затемнения: яркость уходит к краю и возвращается.
    i = 0
    while i < n:
        kind = "white" if luma[i] > 0.85 else "black" if luma[i] < 0.06 else None
        if kind is None:
            i += 1
            continue
        j = i
        while j + 1 < n and ((luma[j + 1] > 0.85) if kind == "white" else (luma[j + 1] < 0.06)):
            j += 1
        span = (j - i + 1) * step
        reach = frames_in(0.6)
        before = luma[max(0, i - reach):i]
        after = luma[j + 1:min(n, j + 1 + reach)]
        if before and after and span <= (0.45 if kind == "white" else 1.2):
            if kind == "black":
                contrast = min(max(before), max(after)) - max(luma[i:j + 1])
                ok = contrast > 0.1
            else:
                contrast = min(luma[i:j + 1]) - max(min(before), min(after))
                ok = contrast > 0.25
            if ok:
                junctions.append({"t": _round(frames[(i + j) // 2]["t"]), "kind": kind})
                mark(i - frames_in(0.35), j + frames_in(0.35))
        i = j + 1

    # 2) Резкие склейки: всплеск смены кадра — сильный или заметно выше соседних кадров.
    for i in range(1, n):
        value = scene[i]
        if used[i] or value < 0.07:
            continue
        if value < scene[i - 1] or (i + 1 < n and value < scene[i + 1]):
            continue
        neighbours = [scene[k] for k in range(max(0, i - 3), min(n, i + 4)) if k != i]
        local = max(neighbours) if neighbours else 0.0
        jump = abs(luma[i] - luma[i - 1])
        # Разница кадров (YDIF) на склейке в разы выше, чем от движения рядом.
        difs = sorted(frames[k].get("dif", 0.0) for k in range(max(0, i - 4), min(n, i + 5)) if k != i)
        typical = difs[len(difs) // 2] if difs else 0.0
        dif = frames[i].get("dif", 0.0)
        if not (value >= high or (value >= 0.1 and value >= 3.5 * local)
                or (value >= 0.07 and value >= 6 * local and jump >= 0.05)
                or (value >= 0.05 and dif >= 0.07 and dif >= 3.5 * max(typical, 0.004))):
            continue
        t = frames[i]["t"] - step / 2
        if any(abs(t - item["t"]) < 0.2 for item in junctions):
            continue
        if value < high:
            # Слабый всплеск бывает и от блика или смены экспозиции. Склейка — это один кадр:
            # разница с соседними кадрами сразу возвращается к обычной; и план после неё — другой.
            prev_dif = frames[i - 1].get("dif", 0.0)
            next_dif = frames[i + 1].get("dif", 0.0) if i + 1 < n else 0.0
            if max(prev_dif, next_dif) > 0.45 * dif:
                continue
            same = _same_scene(thumbs or [], t, 0.15)
            if same is not None and same > 0.75:
                continue
        junctions.append({"t": _round(t), "kind": "cut"})
        mark(i - frames_in(0.12), i + frames_in(0.12))

    # 3) Растворение: за 0,3–1 с цвет и яркость ровно переходят к другому плану, до и после — спокойно.
    sig = [(f["y"], f.get("u", 0.0) * 2, f.get("v", 0.0) * 2, f.get("sat", 0.0), f.get("ylow", 0.0), f.get("yhigh", 0.0))
           for f in frames]

    def mean_sig(first: int, last: int) -> tuple[float, ...] | None:
        first, last = max(0, first), min(n - 1, last)
        if last < first:
            return None
        count = last - first + 1
        return tuple(sum(sig[k][c] for k in range(first, last + 1)) / count for c in range(6))

    def dist(a: tuple[float, ...] | None, b: tuple[float, ...] | None) -> float:
        return sum(abs(x - y) for x, y in zip(a, b)) if a and b else 0.0

    half = frames_in(0.25)
    edge = frames_in(0.1)
    scores: list[tuple[float, int]] = []
    for i in range(half + edge * 3, n - half - edge * 3):
        if any(used[k] for k in range(i - half, i + half + 1)):
            continue
        before = mean_sig(i - half - edge, i - half)
        after = mean_sig(i + half, i + half + edge)
        change = dist(before, after)
        if change < 0.06:
            continue
        steps = [dist(sig[k], sig[k + 1]) for k in range(i - half, i + half)]
        path = sum(steps)
        if path <= 0 or change / path < 0.55 or max(steps) > 0.4 * change:
            continue  # не ровный переход, а скачок (склейка) или дёрганое движение
        calm_before = dist(mean_sig(i - half - edge * 3, i - half - edge * 2), before)
        calm_after = dist(after, mean_sig(i + half + edge * 2, i + half + edge * 3))
        if max(calm_before, calm_after) > 0.3 * change:
            continue
        scores.append((change, i))
    for change, i in sorted(scores, reverse=True):
        if any(used[k] for k in range(i - half, i + half + 1)):
            continue
        # Экспозиция «поплыла» на том же плане (телефон), зум или поворот камеры — это не растворение:
        # растворение соединяет совсем разные планы.
        same = _same_scene(thumbs or [], frames[i]["t"], 0.3)
        if same is None or same > 0.2:
            continue
        junctions.append({"t": _round(frames[i]["t"]), "kind": "dissolve"})
        mark(i - half, i + half)

    start, end = frames[0]["t"], frames[-1]["t"] + step
    # На самом первом и последнем кадре «склейка» — это край файла, а не монтаж.
    junctions = sorted((item for item in junctions if start + 0.1 < item["t"] < end - 0.1), key=lambda item: item["t"])
    edges = [start] + [item["t"] for item in junctions if start + 0.15 < item["t"] < end - 0.15] + [end]
    lengths = [_round(b - a) for a, b in zip(edges, edges[1:]) if b - a > 0.05]
    counts = {kind: sum(1 for item in junctions if item["kind"] == kind) for kind in ("cut", "dissolve", "black", "white")}
    motion = [frames[k].get("dif", 0.0) for k in range(n) if not used[k]]
    return {"list": junctions, "counts": counts, "lengths": lengths,
            "motion": _round(sum(motion) / len(motion), 4) if motion else 0.0}


def _rgb_stats(thumbs: list[dict[str, Any]]) -> dict[str, Any]:
    """Цвет по маленьким кадрам: яркость, контраст, насыщенность, оттенки теней и света, виньетка, полосы."""
    if len(thumbs) > 40:
        # Цвету хватает 40 кадров по всему ролику — так быстро и на длинном видео.
        stride = len(thumbs) / 40
        thumbs = [thumbs[int(k * stride)] for k in range(40)]
    hist = [0] * 64
    count = sat_sum = sat_n = warm_sum = 0.0
    shadow = [0.0, 0.0, 0.0, 0.0]          # r, g, b, n
    light = [0.0, 0.0, 0.0, 0.0]
    hue_x = hue_y = hue_n = 0.0
    vignettes: list[float] = []
    bars_top: list[float] = []
    bars_bottom: list[float] = []
    for thumb in thumbs:
        w, h, data = thumb["w"], thumb["h"], thumb["data"]
        if len(data) < w * h * 3:
            continue
        rows = []
        corner = centre = 0.0
        corner_n = centre_n = 0
        for y in range(h):
            row_sum = 0.0
            row_max = 0.0
            base = y * w * 3
            for x in range(w):
                o = base + x * 3
                r, g, b = data[o] / 255, data[o + 1] / 255, data[o + 2] / 255
                lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
                row_sum += lum
                if lum > row_max:
                    row_max = lum
                hist[min(63, int(lum * 64))] += 1
                count += 1
                top = max(r, g, b)
                if top > 0.1:
                    sat = (top - min(r, g, b)) / top
                    sat_sum += sat
                    sat_n += 1
                    warm_sum += r - b
                    if sat > 0.35:
                        # Средний оттенок ярких цветов (для «неоновой ночи»).
                        hue = math.atan2(math.sqrt(3) * (g - b), 2 * r - g - b)
                        hue_x += math.cos(hue) * sat
                        hue_y += math.sin(hue) * sat
                        hue_n += sat
                if 0.03 < lum < 0.3:
                    shadow[0] += r; shadow[1] += g; shadow[2] += b; shadow[3] += 1
                elif lum > 0.62:
                    light[0] += r; light[1] += g; light[2] += b; light[3] += 1
                fx, fy = x / max(1, w - 1), y / max(1, h - 1)
                if (fx < 0.16 or fx > 0.84) and (0.12 < fy < 0.26 or 0.74 < fy < 0.88):
                    corner += lum
                    corner_n += 1
                elif 0.3 < fx < 0.7 and 0.3 < fy < 0.7:
                    centre += lum
                    centre_n += 1
            rows.append((row_sum / w, row_max))
        # Кинополосы: сверху и снизу ряды почти чёрные, а в середине кадра светло.
        def dark_rows(sequence: list[tuple[float, float]]) -> int:
            k = 0
            for mean, peak in sequence:
                if mean < 0.04 and peak < 0.1:
                    k += 1
                else:
                    break
            return k
        if rows:
            bars_top.append(dark_rows(rows) / h)
            bars_bottom.append(dark_rows(list(reversed(rows))) / h)
        if corner_n and centre_n and centre / centre_n > 0.12:
            vignettes.append((corner / corner_n) / (centre / centre_n))
    if not count:
        return {}
    total = sum(hist)
    def pct(p: float) -> float:
        need = total * p
        acc = 0
        for index, value in enumerate(hist):
            acc += value
            if acc >= need:
                return (index + 0.5) / 64
        return 1.0
    sh = [shadow[k] / shadow[3] for k in range(3)] if shadow[3] else [0.0, 0.0, 0.0]
    li = [light[k] / light[3] for k in range(3)] if light[3] else [0.0, 0.0, 0.0]
    hue = math.degrees(math.atan2(hue_y, hue_x)) % 360 if hue_n else None
    bars = min(_median(bars_top), _median(bars_bottom)) if bars_top else 0.0
    return {
        "luma": _round(sum((index + 0.5) / 64 * value for index, value in enumerate(hist)) / total),
        "p5": _round(pct(0.05)), "p50": _round(pct(0.5)), "p95": _round(pct(0.95)),
        "sat": _round(sat_sum / sat_n if sat_n else 0.0),
        "warmth": _round(warm_sum / sat_n if sat_n else 0.0),
        "shadow_cool": _round(((sh[1] + sh[2]) / 2 - sh[0]) if shadow[3] > count * 0.03 else 0.0),
        "shadow_warm": _round((sh[0] - sh[2]) if shadow[3] > count * 0.03 else 0.0),
        "light_warm": _round((li[0] - li[2]) if light[3] > count * 0.03 else 0.0),
        "hue": _round(hue, 1) if hue is not None else None,
        "vivid_share": _round(hue_n / count),
        "vignette": _round(1 - sorted(vignettes)[int(len(vignettes) * 0.75)]) if vignettes else 0.0,
        "bars": _round(bars),
    }


def colour_profile(thumbs: list[dict[str, Any]]) -> dict[str, Any]:
    """Замеры цвета → ближайший фильтр студии и атмосфера."""
    s = _rgb_stats(thumbs)
    if not s:
        return {"look": "none", "atmo": {}, "notes": []}
    contrast = s["p95"] - s["p5"]
    notes: list[str] = []
    look = "none"
    if s["sat"] < 0.07:
        look = "bw"
        notes.append("чёрно-белый")
    elif s["light_warm"] - s["shadow_warm"] > 0.15 and s["light_warm"] > 0.1 and s["shadow_warm"] < 0.03 and contrast > 0.45:
        look = "teal"
        notes.append("«голливуд»: тени уходят в бирюзу, светлое — в оранжевый")
    elif s["luma"] < 0.27 and s["hue"] is not None and 200 <= s["hue"] <= 320 and s["vivid_share"] > 0.05:
        look = "night"
        notes.append("ночной неон: тёмный кадр и яркие фиолетово-синие цвета")
    elif s["luma"] < 0.33 and s["sat"] < 0.3:
        look = "moody"
        notes.append("мрачный: тёмный, приглушённый цвет")
    elif s["p5"] > 0.09 and contrast < 0.62 and s["warmth"] > 0.03:
        look = "vintage" if s["sat"] < 0.3 else "film"
        notes.append("плёночный: приподнятые тени, мягкий контраст, тёплый оттенок")
    elif s["warmth"] > 0.13 and s["luma"] > 0.3:
        look = "golden"
        notes.append("тёплый «золотой час»")
    elif s["warmth"] > 0.07:
        look = "warm"
        notes.append("тёплый цвет")
    elif s["warmth"] < -0.03:
        look = "cold"
        notes.append("холодный, голубоватый цвет")
    elif s["sat"] > 0.42:
        look = "vivid"
        notes.append("сочные, насыщенные цвета")
    elif contrast < 0.55 and s["luma"] > 0.5:
        look = "soft"
        notes.append("мягкий светлый цвет")
    atmo: dict[str, int] = {}
    frame_in_frame = s["bars"] > 0.2
    if 0.035 <= s["bars"] <= 0.2:
        atmo["bars"] = int(min(100, max(25, round(s["bars"] / 0.18 * 100))))
        notes.append("кинополосы сверху и снизу")
    elif frame_in_frame:
        notes.append("горизонтальное видео в вертикальном кадре (сверху и снизу пусто)")
    if look in ("film", "vintage"):
        atmo.setdefault("grain", 20)
    return {"look": look, "atmo": atmo, "notes": notes, "contrast": _round(contrast), "frame_in_frame": frame_in_frame, **s}


# ---------------------------------------------------------------------------
# Звук: доли музыки, «вжух» на склейках

_BANDS = (("lowpass", "f=150:p=2"), ("bandpass", "f=245:width_type=q:w=1"), ("bandpass", "f=632:width_type=q:w=1"),
          ("bandpass", "f=1581:width_type=q:w=1"), ("bandpass", "f=3873:width_type=q:w=1"), ("highpass", "f=6000:p=2"))


def audio_bands(path: Path, limit: float) -> list[list[float]]:
    """Энергия звука в шести полосах частот, 100 значений в секунду (фильтры — в FFmpeg, быстро)."""
    n = len(_BANDS)
    parts = [f"[0:a:0]aformat=sample_fmts=flt:channel_layouts=mono,aresample=22050,asplit={n}" + "".join(f"[a{i}]" for i in range(n))]
    for i, (kind, args) in enumerate(_BANDS):
        parts.append(f"[a{i}]{kind}={args},aeval=val(0)*val(0),aresample={AUDIO_RATE},"
                     f"aformat=sample_fmts=flt:sample_rates={AUDIO_RATE}:channel_layouts=mono[e{i}]")
    parts.append("".join(f"[e{i}]" for i in range(n)) + f"amerge=inputs={n}[out]")
    done = _run([_ffmpeg(), "-v", "error", "-nostdin", "-t", f"{limit:.3f}", "-i", str(path), "-vn",
                 "-filter_complex", ";".join(parts), "-map", "[out]", "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"],
                max(90, limit * 2))
    if done.returncode:
        return []
    data = array.array("f")
    raw = done.stdout
    data.frombytes(raw[: len(raw) // 4 * 4])
    if sys.byteorder == "big":
        data.byteswap()
    frames = len(data) // n
    return [[max(0.0, data[f * n + b]) for f in range(frames)] for b in range(n)]


def _normalise_onsets(curve: list[float], rate: int) -> list[float]:
    n = len(curve)
    half = max(1, round(rate * 0.2))
    prefix = [0.0]
    for value in curve:
        prefix.append(prefix[-1] + value)
    out = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        out.append(max(0.0, curve[i] - (prefix[hi] - prefix[lo]) / (hi - lo)))
    mean = sum(out) / max(1, n)
    std = math.sqrt(sum((value - mean) ** 2 for value in out) / max(1, n)) or 1.0
    return [value / std for value in out]


def _beat_period(onset: list[float], rate: int) -> tuple[float, float]:
    """Период доли (в кадрах огибающей) и насколько ярко выражен ритм (0 — нет ритма)."""
    n = len(onset)
    min_lag, max_lag = int(rate * 60 / 200), math.ceil(rate * 60 / 60)
    top = min(2 * max_lag + 2, n - 1)
    scores = [0.0] * (2 * max_lag + 3)
    for lag in range(max(1, min_lag - 1), top):
        total = 0.0
        for t in range(n - lag):
            total += onset[t] * onset[t + lag]
        scores[lag] = total / max(1, n - lag)
    best, best_score = min_lag, -1e18
    for lag in range(min_lag, max_lag + 1):
        bpm = 60 * rate / lag
        prior = math.exp(-0.5 * (math.log2(bpm / 120) / 0.9) ** 2)
        score = (scores[lag] + 0.5 * scores[min(len(scores) - 1, lag * 2)]) * prior
        if score > best_score:
            best, best_score = lag, score
    a, b, c = scores[best - 1], scores[best], scores[best + 1]
    shift = max(-0.5, min(0.5, 0.5 * (a - c) / (a - 2 * b + c))) if (a - 2 * b + c) else 0.0
    zero = sum(value * value for value in onset) / max(1, n)
    clarity = scores[best] / zero if zero else 0.0
    return best + shift, clarity


def _track_beats(onset: list[float], period: float) -> list[int]:
    """Доли — динамическое программирование (Ellis 2007), как в studio beats.js."""
    n = len(onset)
    if n < period * 2:
        return []
    sigma = max(1.0, period / 32)
    radius = math.ceil(sigma * 3)
    kernel = [math.exp(-0.5 * (i / sigma) ** 2) for i in range(-radius, radius + 1)]
    local = []
    for t in range(n):
        total = 0.0
        for i in range(-radius, radius + 1):
            k = t + i
            if 0 <= k < n:
                total += onset[k] * kernel[i + radius]
        local.append(total)
    lo, hi = max(1, round(period / 2)), round(period * 2)
    penalty = [0.0] * (hi + 1)
    for d in range(lo, hi + 1):
        penalty[d] = 100 * math.log(d / period) ** 2
    score = [0.0] * n
    back = [-1] * n
    for t in range(n):
        best, origin = -1e18, -1
        for d in range(lo, hi + 1):
            tau = t - d
            if tau < 0:
                break
            value = score[tau] - penalty[d]
            if value > best:
                best, origin = value, tau
        score[t] = local[t] + (max(0.0, best) if origin >= 0 else 0.0)
        back[t] = origin if origin >= 0 and best > 0 else -1
    end = max(range(max(0, n - round(period)), n), key=lambda t: score[t])
    beats = []
    t = end
    while t >= 0:
        beats.append(t)
        if back[t] < 0:
            break
        t = back[t]
    beats.reverse()
    rms = math.sqrt(sum(local[t] ** 2 for t in beats) / max(1, len(beats)))
    first, last = 0, len(beats) - 1
    while first < last and local[beats[first]] < 0.5 * rms:
        first += 1
    while last > first and local[beats[last]] < 0.5 * rms:
        last -= 1
    return beats[first:last + 1]


def audio_profile(bands: list[list[float]], junctions: list[dict[str, Any]]) -> dict[str, Any]:
    if not bands or len(bands[0]) < AUDIO_RATE * 2:
        return {"has_audio": bool(bands), "music": False}
    n = len(bands[0])
    rate = AUDIO_RATE
    total = [sum(band[t] for band in bands) for t in range(n)]
    loud = sorted(total)
    peak = loud[int(n * 0.95)] or 1e-12
    silent = sum(1 for value in total if value < peak * 1e-3) / n
    if peak < 1e-7:
        return {"has_audio": True, "music": False, "silent": True}
    logs = [[math.log1p(100 * math.sqrt(value)) for value in band] for band in bands]
    flux = [[0.0] + [max(0.0, band[t] - band[t - 1]) for t in range(1, n)] for band in logs]
    onset = _normalise_onsets([sum(band[t] for band in flux) for t in range(n)], rate)
    period, clarity = _beat_period(onset, rate)
    beats = _track_beats(onset, period) if clarity > 0.12 else []
    seconds = [_round(t / rate) for t in beats]
    strength = 0.0
    if beats:
        strength = (sum(onset[t] for t in beats) / len(beats)) / ((sum(onset) / n) or 1)
    music = len(beats) >= 6 and clarity > 0.25 and strength > 1.6
    result: dict[str, Any] = {"has_audio": True, "silent_share": _round(silent), "music": music,
                              "clarity": _round(clarity), "beat_strength": _round(strength)}
    # Похоже ли на голос (если текста нет): у речи громкость средних частот «прыгает» на слогах и паузах.
    mid = [bands[2][t] + bands[3][t] for t in range(n)]
    levels = [10 * math.log10(value + 1e-12) for value in mid]
    swings = []
    for begin in range(0, max(1, n - rate), rate // 2):
        window = sorted(levels[begin:begin + rate])
        if len(window) >= rate // 2:
            swings.append(window[int(len(window) * 0.9)] - window[int(len(window) * 0.1)])
    result["voice_swing"] = _round(_median(swings), 1)
    result["voice"] = (not music) and result["voice_swing"] >= 12
    if music:
        gaps = sorted(b - a for a, b in zip(seconds, seconds[1:]))
        beat = _median(gaps) or period / rate
        result.update(tempo=_round(60 / beat, 1), beat=_round(beat), beats=seconds[:400])
        cuts = [item["t"] for item in junctions]
        if cuts:
            near = []
            for cut in cuts:
                distance = min(abs(cut - b) for b in seconds)
                near.append(distance)
            on = sum(1 for d in near if d <= 0.075) / len(near)
            chance = min(1.0, 0.15 / beat)
            result["on_beat"] = _round(on)
            result["on_beat_chance"] = _round(chance)
            result["cuts_follow_beat"] = len(cuts) >= 3 and on >= max(0.6, chance + 0.3)
    # «Вжух» на склейках: шум верхних частот нарастает к склейке. Сравниваем с таким же окном
    # на соседних долях (там тоже звучат тарелки): «вжух» заметно громче их.
    high = [bands[4][t] + bands[5][t] for t in range(n)]
    prefix = [0.0]
    for value in high:
        prefix.append(prefix[-1] + value)
    reach_before, reach_after = int(0.3 * rate), int(0.05 * rate)

    def swell(center: int) -> float:
        lo, hi = max(0, center - reach_before), min(n, center + reach_after)
        return prefix[hi] - prefix[lo] if hi > lo else 0.0

    stride = int(round((result.get("beat") or 0.5) * rate))
    cut_frames = [int(item["t"] * rate) for item in junctions]
    every = sorted(swell(t) for t in range(reach_before, n - reach_after, max(1, rate // 4)))
    floor = every[int(len(every) * 0.5)] if every else 0.0
    hits = checked = 0
    for center in cut_frames:
        if center < reach_before or center > n - reach_after:
            continue
        refs = []
        for k in (-4, -3, -2, -1, 1, 2, 3, 4):
            other = center + k * stride
            if other < reach_before or other > n - reach_after:
                continue
            if any(abs(other - cut) < 0.35 * rate for cut in cut_frames):
                continue
            refs.append(swell(other))
        if len(refs) < 2:
            continue
        checked += 1
        typical = _median(refs)
        value = swell(center)
        if value > 2.2 * max(typical, 1e-12) and value > 1.5 * floor:
            hits += 1
    result["sfx_cuts"] = hits
    result["sfx_share"] = _round(hits / checked) if checked else 0.0
    # Где музыка «вступает»: самое резкое нарастание громкости в первые 8 секунд.
    smooth = []
    width = rate // 4
    for t in range(0, min(n, rate * 8), width):
        smooth.append(sum(total[t:t + width]) / width)
    if len(smooth) > 4:
        jumps = [(smooth[k + 1] / (smooth[k] or 1e-12), k) for k in range(len(smooth) - 1)]
        ratio, k = max(jumps)
        if ratio > 4 and smooth[k + 1] > peak * 0.1:
            result["drop"] = _round((k + 1) * width / rate, 2)
    return result


# ---------------------------------------------------------------------------
# Кадры для ИИ-зрения: лист 3×2

def sheet_times(duration: float, junctions: list[dict[str, Any]], count: int = 6) -> list[float]:
    """Моменты для листа кадров: середины разных планов, первый — самое начало (хук)."""
    edges = [0.0] + [item["t"] for item in junctions] + [duration]
    mids = [((a + b) / 2, b - a) for a, b in zip(edges, edges[1:]) if b - a > 0.3]
    times = [min(0.6, duration * 0.1)]
    if len(mids) > count - 1:
        stride = len(mids) / (count - 1)
        picks = [mids[min(len(mids) - 1, int(k * stride + stride / 2))][0] for k in range(count - 1)]
    else:
        picks = [mid for mid, _ in mids]
        while len(picks) < count - 1:
            picks.append(duration * (len(picks) + 1) / count)
    times += picks
    return sorted({_round(min(max(0.0, t), max(0.0, duration - 0.05)), 2) for t in times})[:count]


def contact_sheet(path: Path, times: list[float], width: int, height: int, workdir: Path) -> bytes:
    """JPEG-лист кадров (3 в ряд): по нему ИИ видит субтитры, цвет и что в кадре."""
    portrait = height >= width
    cell_w, cell_h = (270, 480) if portrait else (480, 270)
    cols = 3 if portrait else 2
    files = []
    for index, t in enumerate(times):
        target = workdir / f"sheet_{index}.jpg"
        done = _run([_ffmpeg(), "-v", "error", "-nostdin", "-y", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                     # Серая рамка между кадрами: текст соседних кадров не сливается в одну строку.
                     "-vf", f"scale={cell_w - 10}:{cell_h - 10}:force_original_aspect_ratio=decrease,"
                            f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2:color=0x3a3a3a",
                     "-q:v", "3", str(target)], 60)
        if done.returncode == 0 and target.is_file():
            files.append(target)
    if not files:
        return b""
    rows = math.ceil(len(files) / cols)
    inputs: list[str] = []
    for item in files:
        inputs += ["-i", str(item)]
    pads = len(files)
    graph = "".join(f"[{k}:v]" for k in range(pads))
    layout = "|".join(f"{(k % cols) * cell_w}_{(k // cols) * cell_h}" for k in range(pads))
    target = workdir / "sheet.jpg"
    if pads == 1:
        return files[0].read_bytes()
    done = _run([_ffmpeg(), "-v", "error", "-nostdin", "-y", *inputs, "-filter_complex",
                 f"{graph}xstack=inputs={pads}:layout={layout}:fill=black,pad={cols * cell_w}:{rows * cell_h}:0:0:black",
                 "-frames:v", "1", "-q:v", "4", str(target)], 60)
    for item in files:
        item.unlink(missing_ok=True)
    return target.read_bytes() if done.returncode == 0 and target.is_file() else b""


# ---------------------------------------------------------------------------
# Разбор целиком

def classify(features: dict[str, Any]) -> str:
    shots = features["shots"]
    audio = features.get("audio") or {}
    speech = features.get("speech") or {}
    if audio.get("music") and audio.get("cuts_follow_beat"):
        return "music_edit"          # склейки в долю — нарезка под музыку, даже если в песне есть слова
    wpm = float(speech.get("wpm") or 0)
    talking = (wpm >= 70 and float(speech.get("coverage") or 0) >= 0.35) or (not speech and audio.get("voice"))
    if talking:
        return "voiceover" if shots["count"] >= 6 and shots["median"] < 2.2 else "talking"
    if audio.get("music") and shots["count"] >= 5 and shots["median"] < 2.6:
        return "music_edit"
    if shots["count"] <= 3 and features.get("motion", 0) < 0.004:
        return "static"
    if shots["median"] >= 2.6 or shots["count"] <= 3:
        return "cinematic"
    return "montage"


def analyse_media(path: Path, workdir: Path, *, progress: Progress | None = None,
                  transcribe: Callable[[Path, Path], dict[str, Any] | None] | None = None,
                  limit: float = MAX_ANALYSE_SECONDS) -> dict[str, Any]:
    """Замеры ролика (без ИИ). transcribe(path, workdir) → {language, text, words:[{start,end,text}]} или None."""
    started = time.time()
    path = Path(path).resolve()
    workdir = Path(workdir).resolve()
    note = progress or (lambda _phase, _percent: None)
    note("probe", 4)
    meta = probe_media(path)
    span = min(meta["duration"], limit)
    note("frames", 10)
    frames, thumbs = scan_video(path, meta, workdir, span)
    note("cuts", 45)
    junctions = find_junctions(frames, thumbs)
    lengths = junctions["lengths"] or [_round(span)]
    note("colour", 52)
    colour = colour_profile(thumbs)
    audio: dict[str, Any] = {"has_audio": False, "music": False}
    if meta["has_audio"]:
        note("audio", 60)
        audio = audio_profile(audio_bands(path, span), junctions["list"])
    speech: dict[str, Any] | None = None
    if transcribe is not None and meta["has_audio"]:
        note("speech", 70)
        try:
            raw = transcribe(path, workdir)
        except Exception:  # noqa: BLE001 — речь — бонус: без неё разбор всё равно готов
            raw = None
        speech = _speech_summary(raw, span) if raw else None
    median = _median(lengths)
    pace = "very_fast" if median < 0.9 else "fast" if median < 1.8 else "medium" if median < 3.5 else "slow"
    features: dict[str, Any] = {
        "version": ANALYSIS_VERSION,
        "meta": {**meta, "analysed": _round(span)},
        "shots": {"count": len(lengths), "lengths": lengths[:300], "median": _round(median),
                  "avg": _round(sum(lengths) / len(lengths)), "first": lengths[0], "pace": pace},
        "junctions": {"counts": junctions["counts"], "list": junctions["list"][:300]},
        "motion": junctions["motion"],
        "colour": {key: colour.get(key) for key in ("look", "atmo", "notes", "luma", "contrast", "sat", "warmth",
                                                     "shadow_cool", "light_warm", "vignette", "bars", "frame_in_frame")},
        "audio": audio,
        "speech": speech,
        "seconds": _round(time.time() - started, 1),
    }
    features["kind"] = classify(features)
    note("done", 80)
    return features


def _speech_summary(raw: dict[str, Any], span: float) -> dict[str, Any] | None:
    words = [item for item in (raw.get("words") or []) if isinstance(item, dict) and str(item.get("text") or "").strip()]
    text = re.sub(r"\s+", " ", str(raw.get("text") or " ".join(str(item.get("text")) for item in words))).strip()
    if not text:
        return None
    count = len(words) or len(text.split())
    if words:
        spoken = sum(max(0.0, float(item.get("end", 0)) - float(item.get("start", 0))) for item in words)
        first = float(words[0].get("start", 0))
        last = float(words[-1].get("end", span))
        hook = " ".join(str(item["text"]).strip() for item in words if float(item.get("start", 0)) < first + 3.0)
    else:
        spoken = span * 0.5
        first, last = 0.0, span
        hook = " ".join(text.split()[:8])
    minutes = max(0.1, (last - first) / 60)
    return {"language": str(raw.get("language") or ""), "words": count, "wpm": _round(count / minutes, 0),
            "coverage": _round(min(1.0, spoken / max(1.0, span)), 2), "first": _round(first, 2),
            "text": text[:1500], "hook": hook[:200]}


# ---------------------------------------------------------------------------
# Рецепт: замеры → настройки студии (как у готовых монтажей в presets.js)

LOOK_NAMES = {
    "none": "без фильтра", "cinema": "«Кино»", "warm": "«Тёплый»", "cold": "«Холодный»", "vivid": "«Сочный»",
    "soft": "«Мягкий»", "bw": "«Ч/Б»", "vintage": "«Винтаж»", "night": "«Неон-ночь»", "teal": "«Голливуд»",
    "golden": "«Золотой час»", "film": "«Плёнка»", "moody": "«Мрачный»",
}
TRANSITION_NAMES = {"none": "обычная склейка", "dissolve": "«Растворение»", "black": "«Через чёрное»",
                    "white": "«Через белое»", "zoom": "«Наезд»", "whip": "«Свайп»", "blur": "«Размытие»",
                    "glow": "«Засвет»", "glitch": "«Глитч»"}
RHYTHM_NAMES = {"fast": "«Быстро» — склейка на каждую долю", "beat": "«В ритм» — склейка каждые 2 доли",
                "calm": "«Спокойно» — склейка раз в такт (4 доли)", "auto": "«Авто» — тихо реже, громко чаще"}
ACCENT_NAMES = {"none": "«Просто склейка»", "zoom": "«Наезд»", "whip": "«Свайп»", "white": "«Вспышка»"}
FONT_BY_KIND = {"sans": "montserrat", "rounded": "rubik", "condensed": "oswald", "serif": "playfair", "book": "garamond",
                "script": "caveat", "wide": "unbounded", "tech": "jura", "heavy": "dela", "arabic": "cairo"}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _hex(value: Any, fallback: str | None) -> str | None:
    text = str(value or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", text):
        text = "#" + "".join(ch * 2 for ch in text[1:])
    return text.lower() if _HEX.match(text) else fallback


def _flag(value: Any, default: bool = False) -> bool:
    """Да/нет из ответа ИИ: модель может прислать true, "true", "да", 1 — или "false" (а bool("false") — это True)."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in ("true", "yes", "1", "да", "есть", "y"):
        return True
    if text in ("false", "no", "0", "нет", "none", "n", ""):
        return False
    return default


def normalise_vision(raw: Any) -> dict[str, Any] | None:
    """Ответ ИИ-зрения → проверенный словарь (всё лишнее и странное отбрасывается)."""
    if not isinstance(raw, dict):
        return None
    pick = lambda value, allowed, fallback: value if value in allowed else fallback  # noqa: E731
    caps = raw.get("captions") if isinstance(raw.get("captions"), dict) else {}
    present = _flag(caps.get("present"))
    captions = {
        "present": present,
        "position": pick(str(caps.get("position") or ""), ("top", "center", "bottom"), "center"),
        "words": pick(str(caps.get("words") or ""), ("1", "2-3", "line"), "2-3"),
        "case": pick(str(caps.get("case") or ""), ("upper", "normal"), "normal"),
        "weight": pick(str(caps.get("weight") or ""), ("bold", "regular"), "bold"),
        "font": pick(str(caps.get("font") or ""), tuple(FONT_BY_KIND), "sans"),
        "color": _hex(caps.get("color"), "#ffffff"),
        "highlight": _hex(caps.get("highlight"), None),
        "background": pick(str(caps.get("background") or ""), ("none", "box", "band", "glass"), "none"),
        "background_color": _hex(caps.get("background_color"), None),
        "outline": _flag(caps.get("outline")),
        "shadow": _flag(caps.get("shadow"), True),
    } if present else {"present": False}
    raw_effects = raw.get("effects")
    if isinstance(raw_effects, str):
        raw_effects = re.split(r"[,;/\n]+", raw_effects)
    elif not isinstance(raw_effects, (list, tuple)):
        raw_effects = []
    effects = [str(item).strip().lower()[:24] for item in raw_effects
               if isinstance(item, (str, int, float)) and str(item).strip()][:8]
    return {
        "content": str(raw.get("content") or "other").strip().lower()[:24],
        "scene": re.sub(r"\s+", " ", str(raw.get("scene") or "")).strip()[:240],
        "captions": captions,
        "text_on_screen": re.sub(r"\s+", " ", str(raw.get("text_on_screen") or "")).strip()[:200],
        "effects": effects,
        "notes": re.sub(r"\s+", " ", str(raw.get("notes") or "")).strip()[:300],
    }


def captions_from_vision(caps: dict[str, Any]) -> dict[str, Any]:
    """Как выглядят субтитры в образце → «Свой стиль» студии (значения конструктора)."""
    words = caps.get("words", "2-3")
    big = {"1": 6.0, "2-3": 5.0, "line": 4.0}[words]
    values: dict[str, Any] = {
        "fontSize": big if caps.get("weight") == "bold" else big - 0.4,
        "weight": 800 if caps.get("weight") == "bold" else 500,
        "textCase": "uppercase" if caps.get("case") == "upper" else "none",
        "outlineWidth": 0.06 if caps.get("outline") else 0,
        "outlineColor": "#000000",
        "shadow": "strong" if caps.get("shadow") and not caps.get("outline") else ("soft" if caps.get("shadow") else "none"),
        "background": caps.get("background", "none"),
        "active": "color" if caps.get("highlight") else "none",
        "wordIn": {"1": "pop", "2-3": "zoom", "line": "fade"}[words],
        "phraseIn": "none" if words != "line" else "fade",
        "phraseOut": "fade",
        "lineHeight": 1.14,
    }
    if values["background"] != "none":
        values["bgColor"] = caps.get("background_color") or "#111114"
        values["bgOpacity"] = 0.72
        if caps.get("highlight"):
            values["active"] = "pill" if words != "line" else "color"
    primary = caps.get("color") or "#ffffff"
    highlight = caps.get("highlight") or primary
    return {
        "on": True, "style": "custom", "builder": values,
        "colors": {"primary": primary, "highlight": highlight},
        "font": FONT_BY_KIND.get(caps.get("font", "sans"), "montserrat"),
        "position": caps.get("position", "center"),
        "phraseLength": "short" if words in ("1", "2-3") else "normal",
        "from": "vision",
    }


def build_recipe(features: dict[str, Any], vision: dict[str, Any] | None = None) -> dict[str, Any]:
    """Настройки «как в образце»: студия применяет их кнопкой «Сделать похожий»."""
    kind = features.get("kind", "montage")
    colour = features.get("colour") or {}
    audio = features.get("audio") or {}
    speech = features.get("speech") or {}
    shots = features.get("shots") or {}
    counts = (features.get("junctions") or {}).get("counts") or {}
    total = sum(counts.values())
    specials = {key: counts.get(key, 0) for key in ("white", "dissolve", "black")}
    main_special = max(specials, key=lambda key: specials[key]) if any(specials.values()) else None
    transition = "none"
    accent = "none"
    if main_special and total and specials[main_special] >= max(2, total * 0.5):
        transition = main_special                    # переход почти на каждой склейке
    elif specials["white"]:
        accent = "white"                             # вспышки изредка — на сильных долях
    recipe: dict[str, Any] = {
        "version": ANALYSIS_VERSION,
        "title": "Как в образце",
        "kind": kind,
        "look": colour.get("look") or "none",
        "atmo": dict(colour.get("atmo") or {}),
        "transition": transition,
        "flash": bool(total and counts.get("white", 0) >= max(2, total * 0.5)),
        "zoom": "off", "jumpZoom": False, "shake": False,
        "magic": [],
        "beat": None,
        "sfx": None,
        "music": None,
        "captions": {"on": False},
    }
    if kind == "talking":
        recipe.update(zoom="dynamic", jumpZoom=True)
        if shots.get("count", 1) >= 3 and shots.get("median", 99) < 4.5:
            recipe["magic"] = ["cut"]          # частые склейки в разговорном — вырезанные паузы
    elif kind == "voiceover":
        recipe.update(zoom="soft", jumpZoom=True)
    elif kind in ("cinematic", "static"):
        recipe["zoom"] = "soft"
    if audio.get("music") and (audio.get("cuts_follow_beat") or kind == "music_edit"):
        beat = float(audio.get("beat") or 0.5)
        lengths = shots.get("lengths") or []
        per_shot = _median([length / beat for length in lengths]) if lengths else 2
        spread = 0.0
        if len(lengths) > 3:
            mean = sum(lengths) / len(lengths)
            spread = math.sqrt(sum((x - mean) ** 2 for x in lengths) / len(lengths)) / (mean or 1)
        rhythm = "auto" if spread > 0.7 else "fast" if per_shot < 1.5 else "beat" if per_shot < 3 else "calm"
        duration = float((features.get("meta") or {}).get("duration") or 30)
        length = min((15, 30, 60), key=lambda option: abs(option - duration))
        recipe["beat"] = {"rhythm": rhythm, "length": length, "accent": accent, "per_shot": _round(per_shot, 1)}
    if audio.get("music") and kind not in ("talking", "voiceover"):
        recipe["music"] = "reference"
    if audio.get("sfx_cuts", 0) >= 2 and audio.get("sfx_share", 0) >= 0.3:
        recipe["sfx"] = {"cut": "fs_whoosh"}
    caps = (vision or {}).get("captions") or {}
    if caps.get("present"):
        recipe["captions"] = captions_from_vision(caps)
    elif speech.get("wpm", 0) >= 70 or (not speech and audio.get("voice")):
        recipe["captions"] = {"on": True, "style": "enzo", "builder": None,
                              "colors": {"primary": "#ffffff", "highlight": "#ffd23f"}, "font": "",
                              "position": "template", "phraseLength": "short", "from": "speech"}
    hook = (vision or {}).get("text_on_screen") or ""
    if hook:
        recipe["hook"] = hook[:90]
    return recipe


# ---------------------------------------------------------------------------
# Что сделано в ролике и как повторить — понятными словами (без ИИ)

def _sec(value: float) -> str:
    return f"{value:.1f}".replace(".", ",") + " с"


def _clock(seconds: float) -> str:
    seconds = int(round(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def _plural(n: int, forms: tuple[str, str, str]) -> str:
    a, b = abs(n) % 100, abs(n) % 10
    form = forms[2] if 10 < a < 20 else forms[1] if 1 < b < 5 else forms[0] if b == 1 else forms[2]
    return f"{n} {form}"


KIND_TITLES = {
    "music_edit": "Нарезка под музыку", "talking": "Разговорное видео", "voiceover": "Закадровый голос и нарезка",
    "cinematic": "Спокойный кинематографичный ролик", "static": "Спокойный план без склеек", "montage": "Монтаж из нескольких планов",
}


def observations(features: dict[str, Any], vision: dict[str, Any] | None = None) -> list[str]:
    meta = features.get("meta") or {}
    shots = features.get("shots") or {}
    counts = (features.get("junctions") or {}).get("counts") or {}
    audio = features.get("audio") or {}
    speech = features.get("speech") or {}
    colour = features.get("colour") or {}
    out: list[str] = []
    shape = {"9:16": "вертикальное", "16:9": "горизонтальное", "1:1": "квадратное", "4:5": "почти квадратное (4:5)"}
    out.append(f"Формат: {shape.get(meta.get('aspect'), meta.get('aspect') or 'видео')} {meta.get('aspect', '')}, "
               f"длина {_clock(meta.get('duration', 0))}.".replace("  ", " "))
    cuts = sum(counts.values())
    if cuts == 0:
        out.append("Монтаж: один план без склеек — держится на том, что в кадре и в звуке.")
    else:
        pace = {"very_fast": "очень быстрый монтаж", "fast": "быстрый монтаж", "medium": "спокойный темп",
                "slow": "медленный, кинематографичный темп"}[shots.get("pace", "medium")]
        out.append(f"Монтаж: {_plural(cuts, ('склейка', 'склейки', 'склеек'))}, план в среднем {_sec(shots.get('avg', 0))} — {pace}.")
    if audio.get("music") and audio.get("tempo"):
        line = f"Музыка: темп {_plural(int(round(audio['tempo'])), ('удар', 'удара', 'ударов'))} в минуту"
        if audio.get("cuts_follow_beat"):
            per = (build_recipe(features).get("beat") or {}).get("per_shot") or 0
            every = "на каждую долю" if per < 1.5 else "каждые 2 доли" if per < 3 else "раз в такт (4 доли)" if per < 6 else "раз в 2 такта"
            line += f"; склейки точно в долю — обычно {every}"
        elif cuts >= 3:
            line += "; склейки не привязаны к долям"
        out.append(line + ".")
    special = [(counts.get("white", 0), "вспышка белым", "вспышки белым", "вспышек белым"),
               (counts.get("dissolve", 0), "растворение", "растворения", "растворений"),
               (counts.get("black", 0), "затемнение", "затемнения", "затемнений")]
    shown = [_plural(n, (a, b, c)) for n, a, b, c in special if n]
    if shown:
        out.append("Переходы: " + ", ".join(shown) + (", остальное — резкие склейки." if counts.get("cut") else "."))
    elif cuts:
        out.append("Переходы: только резкие склейки, без эффектов.")
    sfx = int(audio.get("sfx_cuts") or 0)
    if sfx >= 2 and audio.get("sfx_share", 0) >= 0.3:
        out.append("Звук: на склейках слышен «вжух» — он подчёркивает смену кадра.")
    elif sfx:
        out.append(f"Звук: на {_plural(sfx, ('склейке', 'склейках', 'склейках'))} слышен «вжух» — акцент на смене кадра.")
    notes = colour.get("notes") or []
    if notes:
        out.append("Цвет: " + "; ".join(notes) + ".")
    if speech:
        wpm = int(speech.get("wpm") or 0)
        tempo = "очень быстро" if wpm > 180 else "бодро" if wpm > 140 else "спокойно" if wpm < 100 else "в обычном темпе"
        out.append(f"Голос: говорят {tempo} (~{wpm} слов в минуту).")
        if speech.get("hook"):
            out.append(f"Первые слова: «{speech['hook'][:120]}».")
    elif audio.get("voice"):
        out.append("Голос: в ролике говорят — без субтитров его смотрят хуже (многие смотрят без звука).")
    elif audio.get("music"):
        out.append("Голоса нет — ролик держится на музыке и картинке.")
    first = shots.get("first") or 0
    if cuts and first:
        if first < 1.5:
            out.append(f"Начало: первый план всего {_sec(first)} — зритель сразу видит движение и не успевает пролистать.")
        elif first > 4:
            out.append(f"Начало: первый план длинный ({_sec(first)}) — внимание держит то, что в кадре или в тексте.")
    if audio.get("drop") is not None and audio.get("music") and float(audio["drop"]) <= 1.0:
        out.append("Музыка вступает сразу, с первой секунды.")
    if vision:
        caps = vision.get("captions") or {}
        if caps.get("present"):
            where = {"top": "вверху", "center": "по центру", "bottom": "внизу"}[caps.get("position", "center")]
            size = {"1": "по одному слову", "2-3": "по 2–3 слова", "line": "строкой"}[caps.get("words", "2-3")]
            extra = []
            if caps.get("case") == "upper":
                extra.append("заглавными")
            if caps.get("highlight"):
                extra.append("активное слово выделено цветом")
            if caps.get("background") in ("box", "band", "glass"):
                extra.append("на плашке")
            if caps.get("outline"):
                extra.append("с обводкой")
            out.append(f"Субтитры: {where}, {size}" + (", " + ", ".join(extra) if extra else "") + ".")
        if vision.get("text_on_screen") and not caps.get("present"):
            out.append(f"Текст в кадре: «{vision['text_on_screen'][:100]}».")
        if vision.get("scene"):
            out.append(f"В кадре: {vision['scene'][:200].rstrip('.')}.")
    return out


def plan_steps(features: dict[str, Any], recipe: dict[str, Any]) -> list[dict[str, Any]]:
    """Шаги «как сделать так же в Reel Lab». tool — что студия выполнит кнопкой «Сделать»."""
    steps: list[dict[str, Any]] = []
    beat = recipe.get("beat")
    kind = recipe.get("kind")
    if beat:
        steps.append({"tool": "beat", "title": "Нарезка под музыку", "params": beat,
                      "text": (f"«Монтаж» → «♪ Собрать под музыку»: добавь 4–8 своих видео и трек, ритм {RHYTHM_NAMES[beat['rhythm']]}, "
                               f"длина {beat['length']} с" + (f", на сильных долях — {ACCENT_NAMES[beat['accent']]}" if beat.get("accent") not in (None, "none") else "")
                               + ". Студия сама поставит склейки точно в доли.")})
    elif kind in ("montage", "voiceover") and (features.get("shots") or {}).get("count", 1) >= 4:
        steps.append({"tool": "timeline", "title": "Склей несколько видео", "params": {},
                      "text": "«Монтаж» → «✂ Открыть ленту под видео» → «Видео между»: вставляй свои планы по "
                              f"{_sec((features.get('shots') or {}).get('avg', 2))} каждый. Кнопка «В бит» подгонит концы под музыку."})
    if "cut" in (recipe.get("magic") or []):
        steps.append({"tool": "cut", "title": "Убери паузы", "params": {},
                      "text": "«Монтаж» → «Умный монтаж» → «Найти паузы и лишние слова»: склейки на месте пауз и «эээ» дают тот же бодрый темп."})
    caps = recipe.get("captions") or {}
    if caps.get("on"):
        if caps.get("from") == "vision":
            text = ("«Стиль» → «Свой стиль» с теми же деталями, что в образце: шрифт, размер, цвет активного слова, "
                    "место на экране. Кнопка «Сделать» настроит всё сразу.")
        else:
            text = "«Текст» → «Распознать речь», потом «Стиль» → «Редакционный»: крупно по 1–3 слова, главное — жёлтым."
        steps.append({"tool": "captions", "title": "Субтитры как в образце", "params": caps, "text": text})
    look = recipe.get("look") or "none"
    atmo = recipe.get("atmo") or {}
    if look != "none" or atmo:
        parts = []
        if look != "none":
            parts.append(f"фильтр {LOOK_NAMES.get(look, look)}")
        if atmo.get("bars"):
            parts.append("кинополосы")
        if atmo.get("grain"):
            parts.append("плёночное зерно")
        steps.append({"tool": "look", "title": "Цвет и атмосфера", "params": {"look": look, "atmo": atmo},
                      "text": "«Эффекты» → «Цвет» и «Атмосфера»: " + ", ".join(parts) + "."})
    transition = recipe.get("transition") or "none"
    if transition != "none":
        steps.append({"tool": "transition", "title": "Переходы", "params": {"id": transition},
                      "text": f"«Монтаж» → «Переходы»: {TRANSITION_NAMES.get(transition, transition)} между планами."})
    if recipe.get("zoom") not in (None, "off") or recipe.get("flash"):
        bits = []
        if recipe.get("zoom") == "dynamic":
            bits.append("автозум «Динамичный»")
        elif recipe.get("zoom") == "soft":
            bits.append("автозум «Мягкий»")
        if recipe.get("jumpZoom"):
            bits.append("«Зум на склейках, как у блогеров»")
        if recipe.get("flash"):
            bits.append("«Вспышка на склейках»")
        steps.append({"tool": "camera", "title": "Камера", "params": {key: recipe.get(key) for key in ("zoom", "jumpZoom", "flash", "shake")},
                      "text": "«Эффекты» → «Камера»: " + ", ".join(bits) + "."})
    if recipe.get("sfx"):
        steps.append({"tool": "sfx", "title": "«Вжух» на склейках", "params": recipe["sfx"],
                      "text": "«Звук» → «Звуки к субтитрам» → слой «Склейки и вставки»: «вжух» на каждой склейке."})
    if recipe.get("music") == "reference":
        steps.append({"tool": "music", "title": "Музыка", "params": {},
                      "text": "«Звук» → «Музыка на фон»: свой трек — или возьми звук прямо из этого ролика кнопкой «Взять музыку из образца»."})
    if recipe.get("hook"):
        steps.append({"tool": "hook", "title": "Хук на экране", "params": {"text": recipe["hook"]},
                      "text": "«Текст» → «Хук и описание» → «Показать хук в первые 3 секунды» — короткая фраза, которая цепляет."})
    duration = float((features.get("meta") or {}).get("duration") or 0)
    if duration:
        steps.append({"tool": None, "title": "Длина", "params": {},
                      "text": f"Образец длится {_clock(duration)}. Лишнее отрежь в «Монтаж» → «Обрезка» или на ленте кнопкой «Разрезать»."})
    for index, step in enumerate(steps, start=1):
        step["n"] = index
    return steps


def guide_text(result: dict[str, Any], *, limit: int = 3900) -> str:
    """Разбор для чата Telegram: что сделано и как повторить (обычный текст, без разметки)."""
    features = result.get("features") or {}
    lines = [f"🎬 Разбор: {KIND_TITLES.get(features.get('kind'), 'ролик')}"]
    ai = result.get("ai") or {}
    if ai.get("summary"):
        lines += ["", ai["summary"]]
    lines += ["", "Что в нём сделано:"]
    lines += [f"• {item}" for item in result.get("observations") or []]
    if ai.get("insights"):
        lines += ["", "Почему это работает:"]
        lines += [f"• {item}" for item in ai["insights"]]
    lines += ["", "Как сделать так же в Reel Lab:"]
    for step in result.get("steps") or []:
        lines.append(f"{step['n']}. {step['title']}: {step['text']}")
    if ai.get("tips"):
        lines += ["", "Советы:"]
        lines += [f"• {item}" for item in ai["tips"]]
    if ai.get("idea"):
        lines += ["", f"💡 Идея для твоего ролика: {ai['idea']}"]
    text = "\n".join(lines)
    if len(text) > limit:
        text = text[: limit - 1].rsplit("\n", 1)[0] + "\n…"
    return text


# ---------------------------------------------------------------------------
# ИИ: зрение (кадры образца), живой разбор и ответы на вопросы о студии

STUDIO_GUIDE = """Reel Lab — студия в Telegram (мини-приложение «Студия» в боте) и на компьютере. Режимы «Просто» (шаги по порядку) и «Профи» (вкладки).
Вкладки «Профи» и что в них:
• «Текст»: «Распознать речь» (выбери язык речи), «Загрузить SRT или VTT», «✍ Свой текст» (вставить слова песни/нашида/цитаты; «Подогнать под музыку» — нажимать в начале каждой строки; «Расставить ровно»; можно вписать перевод под строки), «Фразы» (правка текста), «Хук и описание» → «Придумать хук и описание» (ИИ) и «Показать хук в первые 3 секунды», «Подпись поверх видео» (ник/канал), «Перевод субтитров» → язык → «Второй строкой» или «Вместо текста» → «Добавить перевод». «Черновик» вверху (или «Черновики — продолжить монтаж») — студия сама сохраняет работу. Чеченскую и кыргызскую речь не распознаёт ни одна нейросеть — для них «✍ Свой текст» или распознавание по-русски и «Перевод субтитров» на чеченский/кыргызский.
• «Стиль»: «Готовые монтажи» (стиль, цвет, зум, звуки, переходы одним нажатием: Разговорный блог, Подкаст, Магазин, Распаковка, Люкс, Мотивация и кино, Влог, Сторитайм, Новости, Энергия, Цитаты), «Готовые стили» субтитров (Печатная машинка, Слова с картинками, Караоке, Золотой акцент, Вылет с размытием, Звёздная пыль, Неоновая вывеска, Хром 3D, Редакционный, Матовое стекло, Свой стиль), «Свои стили».
• «Настройка»: шрифт (есть «Арабский» и «Арабская каллиграфия»), цвета, размер, место (Сверху/По центру/Снизу), длина фраз (По 1–3 слова/Обычная/Длиннее), «Детали стиля» для «Свой стиль» (обводка, тень, плашка, как выделено активное слово, как появляются слова), «Картинки от ИИ» для стиля «Слова с картинками».
• «Монтаж»: «Лента монтажа» → «✂ Открыть ленту под видео». На ленте: «Видео между» (вставить другое видео), «Поверх» (видео поверх, голос звучит), «Музыка / звук» (в нужное место), «Под музыку», «В бит» (концы вставок — в доли музыки), «Разрезать» (S), «Удалить», «Вернуть кусок», «Зум» (на слово), отмена/возврат; у выделенного куска — «Скорость» (0,25×…3×, замедление и ускорение) и «Переход между видео». «Под музыку» → «♪ Собрать под музыку»: выбрать свои видео и трек, ритм (Авто/Спокойно/В ритм/Быстро), длину (15/30/60 с/вся музыка), акцент на сильных долях (Просто склейка/Наезд/Свайп/Вспышка) → «♪ Собрать». «Переходы» (Без перехода, Растворение, Через чёрное, Через белое, Наезд, Свайп, Размытие, Засвет, Глитч; скорость Быстро/Обычно/Плавно). «Обрезка» («⟦ Начало здесь», «Конец здесь ⟧»). «Умный монтаж» → «Найти паузы и лишние слова» (вырежет паузы, «эээ», повторы, дубли). «Лучшие моменты» → длина → «Найти лучшие моменты» (нарезка длинного видео). «Голос»: «Убрать шум нейросетью», «Выровнять громкость голоса».
• «Эффекты»: «Цвет» (фильтры: Кино, Тёплый, Холодный, Сочный, Мягкий, Ч/Б, Винтаж, Неон-ночь, Голливуд, Золотой час, Плёнка, Мрачный; яркость, контраст, насыщенность, теплота; «✦ Автоулучшение света и цвета»), «Атмосфера» (Чисто, Кино, Плёнка, Мечта, Нуар, Ретро, Мрачно; зерно, засветы, пыль, виньетка, кинополосы), «Камера» (автозум Выключен/Мягкий/Динамичный, «Зумить на лицо», «Зум на склейках, как у блогеров», «Тряска на акцентах», «Вспышка на склейках»), «Улучшение видео» (стабилизация, убрать шум, чёткость), «Текст за человеком».
• «Звук»: «Звуки к субтитрам» (наборы звуков и слои: печать букв, слово, новая фраза, ключевое слово, «Склейки и вставки» — вжух), «Музыка на фон» («Выбрать музыку» — из библиотеки или свой трек/звук из любого видео; громкость, «Тише под голос», с какого места трека), «Голос из видео» (громкость).
• «Собрать видео» — сервер собирает ролик и присылает его в чат бота (телефон можно закрыть). На компьютере — «Скачать MP4».
• «✦ ИИ-помощник»: «Разобрать ролик» — пришли чужое видео, помощник расскажет, как оно сделано, и кнопкой «Сделать похожий» настроит студию так же; «Спросить» — вопросы о монтаже. В боте: пришли видео — «Как это сделано?» или «Монтировать»; можно просто написать вопрос.
Тарифы: бесплатно 2 ролика в день до 1 минуты с водяным знаком (исходник до 3 минут); 290 ₽ — 10 роликов, 990 ₽ — 50 роликов, 1490 ₽ — безлимит на 30 дней (до 10 роликов в день); платные — без знака, ролик до 3 минут, исходник до 15 минут. Оплата звёздами Telegram или картой. Команды бота: /tariffs, /balance, /help, /support."""

ACTION_IDS: dict[str, tuple[str, ...]] = {
    "tab": ("text", "style", "tune", "edit", "fx", "sound"),
    "open": ("beat", "timeline", "lyrics", "projects", "smartcut", "moments", "hook", "translate", "music", "assistant"),
    "atmosphere": ("clean", "cinema", "film", "dream", "noir", "retro", "moody"),
    "look": tuple(LOOK_NAMES),
    "transition": tuple(TRANSITION_NAMES),
    "style": ("typewriter-547", "pictures", "karaoke", "gild", "rush", "stardust", "neon", "chrome", "enzo", "selene", "custom"),
    "preset": ("talking", "podcast", "shop", "unboxing", "luxury", "motivation", "vlog", "story", "news", "hype", "quotes"),
}
ACTIONS_HELP = ("Действия (поле actions, 0–2 штуки, только если прямо помогают): "
                + "; ".join(f'{{"do": "{key}", "id": "{"|".join(values)}"}}' for key, values in ACTION_IDS.items()))


def clean_actions(raw: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        kind, value = str(item.get("do") or ""), str(item.get("id") or "")
        if kind in ACTION_IDS and value in ACTION_IDS[kind] and {"do": kind, "id": value} not in out:
            out.append({"do": kind, "id": value})
    return out[:3]


VISION_SYSTEM = """Ты смотришь кадры короткого видео: лист кадров по порядку (слева направо, сверху вниз), первый кадр — самое начало. Опиши, что видно. Ответ — только JSON:
{"content": "talking_head|broll|dance|travel|food|product|tutorial|gaming|nature|people|text|other",
 "scene": "по-русски, до 20 слов: что в кадре",
 "captions": {"present": true или false — есть ли субтитры речи или крупный текст поверх видео,
   "position": "top|center|bottom",
   "words": "1|2-3|line" — сколько слов видно одновременно,
   "case": "upper|normal", "weight": "bold|regular",
   "font": "sans|rounded|condensed|serif|book|script|wide|tech|heavy|arabic",
   "color": "#rrggbb основного текста", "highlight": "#rrggbb выделенного слова или null",
   "background": "none|box|band|glass", "background_color": "#rrggbb или null",
   "outline": true или false, "shadow": true или false},
 "text_on_screen": "крупный текст в начале ролика (хук) дословно или пустая строка",
 "effects": ["что заметно: zoom, split_screen, emoji, stickers, glitch, light_leaks, grain, blur_background, slow_motion, freeze_frame, color_pop"],
 "notes": "по-русски, до 25 слов: что ещё важно, чтобы повторить такой ролик"}
Не выдумывай: если чего-то не видно — false, null или пустая строка."""

EXPLAIN_SYSTEM = """Ты — опытный монтажёр коротких видео (Reels, TikTok, Shorts). Тебе дали замеры чужого ролика и шаги, как повторить его в студии Reel Lab. Напиши разбор для новичка по-русски: живо, коротко, без воды и без технических слов вроде «scene score». Опирайся только на замеры, ничего не выдумывай. Ответ — только JSON:
{"summary": "2–3 предложения: что это за ролик и на чём держится его эффект",
 "insights": ["2–4 приёма: почему ролик цепляет — хук, темп, звук, цвет, текст"],
 "tips": ["1–3 совета: как сделать свою версию ещё лучше"],
 "idea": "одна идея своего ролика в таком же стиле, одним предложением"}"""

ASK_SYSTEM = """Ты — ИИ-помощник Reel Lab, студии монтажа коротких видео. Отвечай по-русски, коротко и по делу: 1–3 предложения и, если нужно, шаги в виде «Вкладка → Кнопка». Называй кнопки точно так, как в студии (описание ниже). Если такой функции нет — честно скажи и предложи, как сделать похоже тем, что есть. Не выдумывай функции и цены. Вопросы о съёмке, идеях и продвижении роликов — тоже твои: отвечай коротко и полезно. Не про видео — вежливо верни к монтажу.
Ответ — только JSON: {"answer": "текст ответа (можно с переносами строк)", "actions": [...]}
""" + ACTIONS_HELP + "\n\nСтудия:\n" + STUDIO_GUIDE


def _stem_text(text: str) -> str:
    return " " + re.sub(r"[^\w]+", " ", str(text or "").lower().replace("ё", "е")) + " "


# База готовых ответов: частые вопросы отвечаются сразу и бесплатно (без ИИ).
# keys — группы корней слов: подходят, если в вопросе есть по корню из каждой группы.
KNOWLEDGE: list[dict[str, Any]] = [
    {"keys": [("субтитр", "распозна", "текст из видео", "титры")],
     "answer": "Субтитры: вкладка «Текст» → выбери язык речи → «Распознать речь». Если в ролике несколько видео со звуком, студия предложит распознать речь во всех сразу. Текст можно поправить во «Фразах», стиль выбрать во вкладке «Стиль». В режиме «Просто» это первый шаг «Видео и текст».",
     "actions": [{"do": "tab", "id": "text"}]},
    {"keys": [("нашид", "песн", "текст песни", "слова песни", "свой текст", "цитат", "lyrics", "караоке")], "not": ("под песн", "клип"),
     "answer": "Свои слова (нашид, песня, цитата): «Текст» → «✍ Свой текст» → вставь строки → «Подогнать под музыку» (ролик заиграет — нажимай кнопку в начале каждой строки) или «Расставить ровно». Слова подстроятся под голос. Для пения подойдёт стиль «Караоке» — слово заливается цветом, пока его поют.",
     "actions": [{"do": "open", "id": "lyrics"}, {"do": "style", "id": "karaoke"}]},
    {"keys": [("перевод", "переве", "второй строк", "на русский", "на английский")],
     "answer": "Перевод: «Текст» → «Перевод субтитров» → выбери язык → «Второй строкой» (под оригиналом) или «Вместо текста» → «Добавить перевод». Для своего текста перевод можно вписать прямо в «✍ Свой текст» — строка под строкой.",
     "actions": [{"do": "open", "id": "translate"}]},
    {"keys": [("чечен", "чеченск", "чеченский", "чеченском", "чеченские", "чеченскую", "чеченского", "нохч", "нохчийн",
               "кыргыз", "кыргызск", "кыргызский", "кыргызском", "кыргызские", "кыргызскую", "кыргызского",
               "киргиз", "киргизск", "киргизский", "киргизском", "киргизского")],
     "answer": "Чеченский и кыргызский: распознавать речь на этих языках пока не умеет ни одна нейросеть. Есть два способа: «Текст» → «✍ Свой текст» — вставь слова, они встанут под голос; или распознай речь на русском и добавь «Перевод субтитров» → «Чеченский» или «Кыргызский» («Второй строкой» или «Вместо текста»). Все шрифты студии пишут буквы Ӏ, ң, ө, ү.",
     "actions": [{"do": "open", "id": "lyrics"}, {"do": "open", "id": "translate"}]},
    {"keys": [("араб", "каллиграф", "коран")],
     "answer": "Арабский: «Настройка» → «Шрифт» → группы «Арабский» и «Арабская каллиграфия» (Amiri, Aref Ruqaa, Katibeh, Qahiri и другие). Текст пишется справа налево сам. Русский перевод под арабским — «Перевод субтитров» → «Второй строкой».",
     "actions": [{"do": "tab", "id": "tune"}]},
    {"keys": [("музык", "трек", "песню на фон", "фонов")], "not": ("под музык", "в бит", "нашид", "слова песни", "текст песни"),
     "answer": "Музыка на фон: «Звук» → «Музыка на фон» → «Выбрать музыку» — из библиотеки или свой трек (подойдёт и звук из любого видео). Там же громкость и «Тише под голос». Чтобы положить музыку в точное место — на ленте кнопка «Музыка / звук».",
     "actions": [{"do": "open", "id": "music"}]},
    {"keys": [("под музык", "в бит", "в такт", "в долю", "по битам", "под бит", "под ритм", "под песн", "под трек")],
     "answer": "Под музыку: «Монтаж» → «♪ Собрать под музыку» → добавь свои видео и трек, выбери ритм (Авто, Спокойно, В ритм, Быстро) и длину → «♪ Собрать». Склейки встанут точно в доли. Уже готовые вставки на ленте подгоняет кнопка «В бит».",
     "actions": [{"do": "open", "id": "beat"}]},
    {"keys": [("переход",)],
     "answer": "Переходы: «Монтаж» → «Переходы» — Растворение, Через чёрное, Через белое, Наезд, Свайп, Размытие, Засвет, Глитч и скорость перехода. Для одной склейки: выдели её на ленте → «Переход между видео».",
     "actions": [{"do": "tab", "id": "edit"}]},
    {"keys": [("несколько видео", "склеить", "склей", "соедин", "объедин", "вставить видео", "добавить видео", "два видео", "много видео")],
     "answer": "Несколько видео: «Монтаж» → «✂ Открыть ленту под видео» → «Видео между» (вставить другое видео там, где бегунок) или «Поверх» (картинка поверх, голос звучит). Куски двигаются и обрезаются прямо на ленте. Быстрее всего — «♪ Собрать под музыку»: студия сама нарежет видео в доли трека.",
     "actions": [{"do": "open", "id": "timeline"}, {"do": "open", "id": "beat"}]},
    {"keys": [("замедл", "ускор", "слоумо", "slow", "скорост")],
     "answer": "Скорость: открой ленту («Монтаж» → «✂ Открыть ленту под видео»), выдели кусок → «Скорость»: 0,25× и 0,5× — замедление, 1,5–3× — ускорение. Чтобы замедлить только часть, сначала «Разрезать» в нужных местах.",
     "actions": [{"do": "open", "id": "timeline"}]},
    {"keys": [("обрез", "укорот", "отрез", "лишнее", "вырез")], "not": ("пауз", "эээ"),
     "answer": "Обрезать: «Монтаж» → «Обрезка» → поставь бегунок → «⟦ Начало здесь» и «Конец здесь ⟧». Вырезать кусок из середины: на ленте «Разрезать» в двух местах → выдели кусок → «Удалить» (вернуть — «Вернуть кусок»).",
     "actions": [{"do": "tab", "id": "edit"}]},
    {"keys": [("пауз", "эээ", "запинк", "дубл", "паразит")],
     "answer": "Паузы и «эээ»: «Монтаж» → «Умный монтаж» → выбери, насколько плотно → «Найти паузы и лишние слова». Каждую склейку можно вернуть галочкой.",
     "actions": [{"do": "open", "id": "smartcut"}]},
    {"keys": [("длинн", "интервью", "подкаст", "стрим", "лучшие момент", "нарезк", "нарезать на")], "not": ("под музык", "фильм"),
     "answer": "Длинное видео: «Монтаж» → «Лучшие моменты» → длина ролика → «Найти лучшие моменты» — ИИ найдёт сильные куски, каждый станет отдельным роликом. Исходник на платном тарифе — до 15 минут, готовый ролик — до 3 минут.",
     "actions": [{"do": "open", "id": "moments"}]},
    {"keys": [("фильм", "смонтир", "эдит", "edit", "большой монтаж", "монтаж из", "клип")],
     "answer": "Большой монтаж (фильм, эдит, клип): «Монтаж» → «✂ Открыть ленту под видео». На ленте — «Видео между» и «Поверх» для своих планов, «Разрезать» и «Удалить», «Скорость» для замедления, «Переход между видео», «Музыка / звук». Быстрый старт — «♪ Собрать под музыку»: студия нарежет все видео в доли трека, дальше правь на ленте. Цвет «как в кино» — «Эффекты» → «Атмосфера» → «Кино». Монтаж сохраняется сам. Готовый ролик — до 3 минут на платном тарифе.",
     "actions": [{"do": "open", "id": "timeline"}, {"do": "open", "id": "beat"}]},
    {"keys": [("цвет", "фильтр", "цветокор", "яркост", "контраст")],
     "answer": "Цвет: «Эффекты» → «Цвет» — фильтры (Кино, Голливуд, Золотой час, Плёнка, Ч/Б и другие), яркость, контраст, насыщенность, теплота. «✦ Автоулучшение света и цвета» поправит всё одним нажатием.",
     "actions": [{"do": "tab", "id": "fx"}]},
    {"keys": [("зерн", "засвет", "плёнк", "пленк", "полос", "виньет", "атмосфер", "пыль", "ретро", "винтаж", "кинемат")],
     "answer": "Атмосфера: «Эффекты» → «Атмосфера» — готовые Кино, Плёнка, Мечта, Нуар, Ретро, Мрачно, или по отдельности зерно, засветы, пыль, виньетка и кинополосы.",
     "actions": [{"do": "atmosphere", "id": "cinema"}, {"do": "tab", "id": "fx"}]},
    {"keys": [("зум", "приблиз", "наезд", "тряск", "вспышк")], "not": ("переход",),
     "answer": "Камера: «Эффекты» → «Камера» — автозум на важных словах (Мягкий или Динамичный), «Зумить на лицо», «Зум на склейках, как у блогеров», «Тряска на акцентах», «Вспышка на склейках». Зум на конкретное слово — на ленте кнопка «Зум».",
     "actions": [{"do": "tab", "id": "fx"}]},
    {"keys": [("стил", "шрифт", "красив")], "not": ("свой стиль", "своего стиля"),
     "answer": "Стиль субтитров: вкладка «Стиль» → «Готовые стили» (на карточках видно настоящее превью) или «Готовые монтажи» — стиль, цвет, зум и звуки сразу. Шрифт, цвет, размер и место — во вкладке «Настройка».",
     "actions": [{"do": "tab", "id": "style"}]},
    {"keys": [("свой стиль", "своего стиля", "свои субтитры", "обводк", "плашк")],
     "answer": "Свой стиль: «Стиль» → «Свой стиль», потом «Настройка» → «Детали стиля»: размер, обводка, тень, плашка, чем выделено активное слово и как появляются слова. Кнопка «Сохранить» — стиль появится в «Свои стили».",
     "actions": [{"do": "style", "id": "custom"}]},
    {"keys": [("хук", "описани", "хэштег", "хештег", "заголов")],
     "answer": "Хук и описание: «Текст» → «Хук и описание» → «Придумать хук и описание» — ИИ напишет цепляющую фразу, текст поста и хэштеги. «Показать хук в первые 3 секунды» выведет фразу на экран.",
     "actions": [{"do": "open", "id": "hook"}]},
    {"keys": [("ник", "подпис", "логотип", "водян", "название канала")], "not": ("водяной знак", "водяного знака", "без знака"),
     "answer": "Подпись: «Текст» → «Подпись поверх видео» — ник или название канала на весь ролик. Её можно перетащить и увеличить прямо на видео.",
     "actions": [{"do": "tab", "id": "text"}]},
    {"keys": [("водяной знак", "водяного знака", "без знака", "тариф", "цена", "стоит", "оплат", "купить", "сколько стоит", "лимит")],
     "answer": "Бесплатно — 2 ролика в день до 1 минуты, с водяным знаком. Без знака и до 3 минут: 290 ₽ — 10 роликов, 990 ₽ — 50 роликов, 1490 ₽ — безлимит на 30 дней (до 10 роликов в день). Оплата звёздами или картой: команда /tariffs в боте.",
     "actions": []},
    {"keys": [("сохран", "скача", "скачать", "экспорт", "получить видео", "где видео", "готовое видео")],
     "answer": "Готовый ролик: «Собрать видео» — сервер соберёт его и пришлёт в чат бота, студию можно закрыть. Монтаж сохраняется сам: вернуться к нему — кнопка «Черновик» вверху.",
     "actions": [{"do": "open", "id": "projects"}]},
    {"keys": [("проект", "черновик", "продолж", "вернуться к монтаж", "пропал", "удалил")],
     "answer": "Студия сохраняет монтаж сама. Вернуться: кнопка «Черновик» вверху студии (или открой то же видео — студия предложит продолжить).",
     "actions": [{"do": "open", "id": "projects"}]},
    {"keys": [("шум", "голос", "звук голоса", "громкост голос")], "not": ("музык",),
     "answer": "Голос: «Монтаж» → «Голос» → «Убрать шум нейросетью» и «Выровнять громкость голоса». Громкость голоса — «Звук» → «Голос из видео».",
     "actions": [{"do": "tab", "id": "edit"}]},
    {"keys": [("вжух", "звуков", "звуки", "эффект звук", "свуш")],
     "answer": "Звуки: «Звук» → «Звуки к субтитрам» — наборы звуков к словам и фразам. Слой «Склейки и вставки» добавляет «вжух» на склейках и вставках.",
     "actions": [{"do": "tab", "id": "sound"}]},
    {"keys": [("за человек", "за спин", "за собой")],
     "answer": "Текст за человеком: «Эффекты» → «Текст за человеком» → «Прятать субтитры за человеком». Лучше всего, когда текст на уровне плеч или головы.",
     "actions": [{"do": "tab", "id": "fx"}]},
    {"keys": [("как сделан", "как он сделан", "повтор", "разбер", "образец", "как у блогер", "как в видео", "как в этом",
               "чужое видео", "чужой ролик", "такое же видео", "такой же ролик", "так же как", "из инст", "из тикток", "из рилс")],
     "answer": "Пришли этот ролик в «✦ ИИ-помощник» → «Разобрать ролик» (или просто отправь видео боту): помощник расскажет, как он сделан, и кнопкой «Сделать похожий» настроит студию так же.",
     "actions": [{"do": "open", "id": "assistant"}]},
]


def faq_answer(question: str) -> dict[str, Any] | None:
    """Готовый ответ, если вопрос точно про одну из частых тем (иначе None — спросим ИИ)."""
    text = _stem_text(question)
    best: tuple[int, dict[str, Any]] | None = None
    for entry in KNOWLEDGE:
        if any(bad in text for bad in entry.get("not", ())):
            continue
        groups = entry["keys"]
        hits = sum(1 for group in groups if any(key in text for key in group))
        if hits == len(groups):
            strength = sum(max((len(key) for key in group if key in text), default=0) for group in groups)
            if best is None or strength > best[0]:
                best = (strength, entry)
    if best is None:
        return None
    entry = best[1]
    return {"answer": entry["answer"], "actions": list(entry.get("actions") or []), "source": "faq"}


_TROUBLE = re.compile(r"почему|не работает|не получа|ошибк|не грузит|не открыва|не сохраня|не собира|завис|сломал|глюч|темнее|светлее|рассинхрон|не совпада", re.I)


def faq_direct(question: str) -> dict[str, Any] | None:
    """Готовый ответ без ИИ — только на короткий вопрос «как сделать…» (длинный или «почему не работает» — ИИ)."""
    text = re.sub(r"\s+", " ", str(question or "")).strip()
    if len(text) > 70 or _TROUBLE.search(text):
        return None
    return faq_answer(text)


class Assistant:
    """ИИ-слой помощника. ask_json(system, user, max_tokens=...) → (json, provider);
    see(system, text, images) → текст ответа модели, которая видит картинки (или None — зрения нет)."""

    def __init__(self, ask_json: Callable[..., tuple[Any, str]],
                 see: Callable[[str, str, list[bytes]], str] | None = None):
        self.ask_json = ask_json
        self.see = see

    def vision(self, sheet: bytes, speech_text: str = "") -> dict[str, Any] | None:
        if not sheet or self.see is None:
            return None
        prompt = "Кадры ролика по порядку."
        if speech_text:
            prompt += f"\nРечь в ролике (распознана автоматически): {speech_text[:600]}"
        raw = self.see(VISION_SYSTEM, prompt, [sheet])
        return normalise_vision(_parse_json(raw))

    def explain(self, features: dict[str, Any], recipe: dict[str, Any], facts: list[str], steps: list[dict[str, Any]],
                vision: dict[str, Any] | None = None) -> dict[str, Any] | None:
        audio = features.get("audio") or {}
        brief = {
            "тип": KIND_TITLES.get(features.get("kind"), features.get("kind")),
            "длина_с": (features.get("meta") or {}).get("duration"),
            "формат": (features.get("meta") or {}).get("aspect"),
            "планов": (features.get("shots") or {}).get("count"),
            "средний_план_с": (features.get("shots") or {}).get("avg"),
            "первый_план_с": (features.get("shots") or {}).get("first"),
            "переходы": (features.get("junctions") or {}).get("counts"),
            "музыка": bool(audio.get("music")), "темп": audio.get("tempo"),
            "склейки_в_долю": audio.get("cuts_follow_beat"), "вжух_на_склейках": audio.get("sfx_cuts"),
            "цвет": (features.get("colour") or {}).get("notes"),
        }
        speech = features.get("speech") or {}
        user = ("Замеры ролика:\n" + json.dumps(brief, ensure_ascii=False)
                + "\n\nЧто видно по замерам:\n" + "\n".join(f"- {item}" for item in facts)
                + "\n\nШаги в Reel Lab:\n" + "\n".join(f"{step['n']}. {step['title']}: {step['text']}" for step in steps))
        if vision:
            user += "\n\nЧто видно на кадрах:\n" + json.dumps(vision, ensure_ascii=False)
        if speech.get("text"):
            user += f"\n\nРечь (начало): {speech['text'][:700]}"
        raw, provider = self.ask_json(EXPLAIN_SYSTEM, user, max_tokens=1600)
        if not isinstance(raw, dict):
            return None
        text = lambda value, size: re.sub(r"\s+", " ", str(value or "")).strip()[:size]  # noqa: E731
        listed = lambda value, count, size: [text(item, size) for item in (value if isinstance(value, list) else []) if text(item, size)][:count]  # noqa: E731
        result = {"summary": text(raw.get("summary"), 500), "insights": listed(raw.get("insights"), 4, 260),
                  "tips": listed(raw.get("tips"), 3, 260), "idea": text(raw.get("idea"), 300), "provider": provider}
        return result if result["summary"] or result["insights"] else None

    def answer(self, question: str, history: list[dict[str, Any]] | None = None,
               context: dict[str, Any] | None = None, *, use_ai: bool = True) -> dict[str, Any]:
        question = re.sub(r"\s+", " ", str(question or "")).strip()[:1200]
        if not question:
            return {"answer": "Напиши вопрос — например, «как сделать переходы» или «как наложить музыку».", "actions": [], "source": "faq"}
        direct = faq_direct(question)
        if direct is not None:
            return direct
        known = faq_answer(question)
        if not use_ai:
            return known or {"answer": ("Точного ответа в моей базе нет. Подключи ИИ (кнопка «Ключ ИИ» вверху) — и я отвечу "
                                        "на любой вопрос о монтаже. А пока загляни во вкладки «Монтаж» и «Эффекты» — там почти всё."),
                             "actions": [], "source": "faq"}
        lines = []
        for item in (history or [])[-6:]:
            if isinstance(item, dict) and str(item.get("text") or "").strip():
                who = "Пользователь" if item.get("role") == "user" else "Помощник"
                lines.append(f"{who}: {str(item['text']).strip()[:500]}")
        user = ""
        if context:
            user += "Сейчас в студии: " + json.dumps(context, ensure_ascii=False)[:400] + "\n"
        if lines:
            user += "Разговор:\n" + "\n".join(lines) + "\n"
        user += f"Вопрос: {question}"
        try:
            raw, provider = self.ask_json(ASK_SYSTEM, user, max_tokens=900)
        except Exception as error:  # noqa: BLE001 — нет ИИ: отвечаем из базы, если есть что
            if known is not None:
                return known
            if getattr(error, "code", "") == "ai_format":
                return {"answer": "Не получилось сформулировать ответ. Спроси чуть по-другому — например, «как сделать …».",
                        "actions": [], "source": "error"}
            raise
        answer = str((raw or {}).get("answer") or "").strip() if isinstance(raw, dict) else ""
        if not answer:
            if known is not None:
                return known
            answer = "Не получилось ответить. Спроси по-другому или напиши /support."
        return {"answer": answer[:1800], "actions": clean_actions((raw or {}).get("actions") if isinstance(raw, dict) else None),
                "source": "ai", "provider": provider}


def _parse_json(text: Any) -> Any:
    if isinstance(text, (dict, list)):
        return text
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw)
    try:
        return json.loads(raw)
    except ValueError:
        match = re.search(r"\{.*\}", raw, flags=re.S)
        if match:
            try:
                return json.loads(match.group(0))
            except ValueError:
                return None
    return None


def finish(features: dict[str, Any], *, vision: dict[str, Any] | None = None,
           ai: dict[str, Any] | None = None) -> dict[str, Any]:
    """Итог разбора: замеры, рецепт, факты и шаги (и живой текст ИИ, если был)."""
    recipe = build_recipe(features, vision)
    facts = observations(features, vision)
    steps = plan_steps(features, recipe)
    return {"version": ANALYSIS_VERSION, "features": features, "vision": vision, "recipe": recipe,
            "observations": facts, "steps": steps, "ai": ai, "title": KIND_TITLES.get(features.get("kind"), "Ролик")}
