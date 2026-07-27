import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { appRoot, pythonExecutable } from "../server/config.js";

const runnerPath = join(appRoot, "scripts", "phoneme_viseme_measurement.py");
const mappingPath = join(appRoot, "evaluators", "phoneme-viseme", "viseme-mapping.v1.json");
const dependenciesAvailable = existsSync(runnerPath)
  && existsSync(mappingPath)
  && spawnSync(pythonExecutable, ["-c", "import cv2,numpy"], { stdio: "ignore" }).status === 0;
const runnerIt = dependenciesAvailable ? it : it.skip;

function runProbe(lines: string[]): Record<string, unknown> {
  const source = [
    "import importlib.util,json,pathlib",
    "import numpy as np",
    `runner_path=pathlib.Path(${JSON.stringify(runnerPath)})`,
    "spec=importlib.util.spec_from_file_location('ltx_pv_runner', runner_path)",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    ...lines,
  ].join("\n");
  const result = spawnSync(pythonExecutable, ["-c", source], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

runnerIt("parses the MFA phone tier and applies the declared phone normalization", () => {
  const result = runProbe([
    "textgrid='''File type = \"ooTextFile\"",
    "Object class = \"TextGrid\"",
    "item [1]:",
    "    class = \"IntervalTier\"",
    "    name = \"phones\"",
    "    intervals [1]:",
    "        xmin = 0",
    "        xmax = 0.5",
    "        text = \"ˈaː\"",
    "    intervals [2]:",
    "        xmin = 0.5",
    "        xmax = 1.0",
    "        text = \"AH0\"",
    "'''",
    "intervals=module.parse_textgrid_intervals(textgrid)",
    "print(json.dumps({'intervals': intervals, 'normalized': [module.normalize_phone(v) for v in ('ˈaː','AH0','tʃ')]}))",
  ]);

  expect(result).toEqual({
    intervals: [[0, 0.5, "ˈaː"], [0.5, 1, "AH0"]],
    normalized: ["a", "AH", "tʃ"],
  });
});

runnerIt("quarantines unknown phones instead of treating them as speech evidence", () => {
  const result = runProbe([
    `mapping,codes=module.load_viseme_mapping(pathlib.Path(${JSON.stringify(mappingPath)}))`,
    "times=np.asarray([0.25,0.75,1.25,1.75],dtype=np.float64)",
    "intervals=[(0.0,0.5,'p'),(0.5,1.0,'UNMAPPED'),(1.0,1.5,'aː'),(1.5,2.0,'sil')]",
    "targets=module.phone_targets(times,intervals,mapping,codes)",
    "print(json.dumps({'classIds': targets['class_ids'].tolist(), 'speech': targets['speech'].tolist(), 'known': targets['known'].tolist(), 'openingFinite': np.isfinite(targets['opening']).tolist(), 'roundingFinite': np.isfinite(targets['rounded']).tolist(), 'unknown': targets['unknown'], 'coverage': targets['coverage']}))",
  ]);

  expect(result.classIds).toEqual([1, -1, 12, 0]);
  expect(result.speech).toEqual([true, false, true, false]);
  expect(result.known).toEqual([true, false, true, true]);
  expect(result.openingFinite).toEqual([true, false, true, true]);
  expect(result.roundingFinite).toEqual([true, false, true, true]);
  expect(result.unknown).toEqual(["UNMAPPED"]);
  expect(result.coverage).toBeCloseTo(2 / 3);
});

runnerIt("reports a positive lag when visible mouth motion follows the audio target", () => {
  const result = runProbe([
    "rng=np.random.default_rng(23072026)",
    "target=rng.normal(size=96)",
    "observed=np.roll(target,2)",
    "times=np.arange(96,dtype=np.float64)/24.0",
    "lag,confidence=module.lag_measurement(target,observed,times)",
    "print(json.dumps({'lag': lag, 'confidence': confidence}))",
  ]);

  expect(result.lag).toBe(83);
  expect(result.confidence).toEqual(expect.any(Number));
});

runnerIt("normalizes negative or non-zero source PTS without dropping decoded frames", () => {
  const result = runProbe([
    "negative=[-0.125+(index/24.0) for index in range(48)]",
    "positive=[2.5+(index/25.0) for index in range(50)]",
    "a=module.normalized_frame_centers(negative)",
    "b=module.normalized_frame_centers(positive)",
    "print(json.dumps({'negativeCount':len(a),'negativeFirst':a[0],'negativeLast':a[-1],'positiveCount':len(b),'positiveFirst':b[0],'positiveLast':b[-1]}))",
  ]);

  expect(result.negativeCount).toBe(48);
  expect(result.negativeFirst).toBeCloseTo(1 / 48);
  expect(result.negativeLast).toBeCloseTo(47.5 / 24);
  expect(result.positiveCount).toBe(50);
  expect(result.positiveFirst).toBeCloseTo(1 / 50);
  expect(result.positiveLast).toBeCloseTo(49.5 / 25);
});

runnerIt("moves MFA intervals onto the signed audio/video stream timeline", () => {
  const root = mkdtempSync(join(tmpdir(), "ltx-pv-pts-"));
  try {
    const video = join(root, "offset.mp4");
    const generated = spawnSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=2",
      "-itsoffset", "0.125",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "mpeg4",
      "-c:a", "aac",
      "-y",
      video,
    ], { encoding: "utf8", timeout: 15_000 });
    expect(generated.status, generated.stderr).toBe(0);

    const result = runProbe([
      `video=pathlib.Path(${JSON.stringify(video)})`,
      "offset=module.stream_start_offset_seconds(video)",
      "aligned=module.align_intervals_to_video_timeline([(0.0,0.5,'p')],offset)",
      "print(json.dumps({'offset':offset,'aligned':aligned}))",
    ]);

    expect(result.offset).toEqual(expect.any(Number));
    expect(result.offset as number).toBeGreaterThan(0.08);
    expect((result.aligned as number[][])[0][0]).toBeCloseTo(result.offset as number, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

runnerIt("emits bounded raw measurement evidence without granting Product-GO", () => {
  const result = runProbe([
    "count=96",
    "times=(np.arange(count,dtype=np.float64)+0.5)/24.0",
    "target=np.tile(np.asarray([0.0,0.25,0.55,1.0,0.45,0.25],dtype=np.float64),16)",
    "bilabial=target==0.0",
    "rounded=target==0.45",
    "speech=np.ones(count,dtype=np.bool_)",
    "opening=0.05+target*0.1",
    "closure=np.where(bilabial,0.9,0.1)",
    "tracks={'times':times,'opening':opening,'rounding':rounded.astype(np.float64),'closure':closure,'blur':np.full(count,100.0),'yaw':np.full(count,4.0),'pitch':np.full(count,3.0),'tracked':np.ones(count,dtype=np.bool_),'mouthTracked':np.ones(count,dtype=np.bool_),'multi':np.zeros(count,dtype=np.bool_)}",
    "targets={'opening':target,'bilabial':bilabial,'rounded':rounded.astype(np.float64),'speech':speech,'known':np.ones(count,dtype=np.bool_),'coverage':1.0,'unknown':[]}",
    "policy={'minimumSampledFrames':24,'minimumUsableDurationSeconds':1.0,'minimumFaceTrackCoverage':0.8,'minimumMouthTrackCoverage':0.8,'maximumMultiFaceFrameRatio':0.05,'minimumPhoneCoverage':0.9,'requireNoUnknownPhones':True,'minimumMedianBlurVariance':20.0,'maximumYawP95Degrees':35.0,'maximumPitchP95Degrees':25.0}",
    "raw,offset,content,detail,sufficient=module.measurement(tracks,targets,'a'*64,'b'*64,policy)",
    "print(json.dumps({'raw':raw,'offset':offset,'content':content,'detail':detail,'sufficient':sufficient}))",
  ]);

  const raw = result.raw as Record<string, unknown>;
  expect(raw).toMatchObject({
    method: "mfa-mediapipe-de.v1",
    bilabialClosureF1: 1,
    phoneCoverage: 1,
    faceTrackCoverage: 1,
    mouthTrackCoverage: 1,
    multiFaceFrameRatio: 0,
    sampledFrames: 96,
  });
  expect(raw.usableDurationSeconds).toBeCloseTo(4);
  expect(result.content).toEqual({
    status: "insufficient",
    gatePassed: false,
    frameMacroF1: null,
    transitionF1: null,
  });
  expect(result.sufficient).toBe(true);
});

runnerIt("derives fallback closure thresholds only from known tracked phones", () => {
  const result = runProbe([
    "count=12",
    "times=(np.arange(count,dtype=np.float64)+0.5)/24.0",
    "known=np.arange(count)<6",
    "opening=np.asarray([0.01,0.02,0.8,0.8,0.8,0.8,0.0,0.0,0.0,0.0,0.0,0.0],dtype=np.float64)",
    "tracks={'times':times,'opening':opening,'rounding':np.zeros(count),'closure':np.full(count,np.nan),'blur':np.full(count,100.0),'yaw':np.zeros(count),'pitch':np.zeros(count),'tracked':np.ones(count,dtype=np.bool_),'mouthTracked':np.ones(count,dtype=np.bool_),'multi':np.zeros(count,dtype=np.bool_)}",
    "targets={'opening':np.where(known,opening,np.nan),'bilabial':np.asarray([True,True,False,False,False,False,False,False,False,False,False,False]),'rounded':np.zeros(count),'speech':known,'known':known,'coverage':1.0,'unknown':[]}",
    "policy={'minimumSampledFrames':1,'minimumUsableDurationSeconds':0.1,'minimumFaceTrackCoverage':0.1,'minimumMouthTrackCoverage':0.1,'maximumMultiFaceFrameRatio':0.5,'minimumPhoneCoverage':0.5,'requireNoUnknownPhones':False,'minimumMedianBlurVariance':1.0,'maximumYawP95Degrees':35.0,'maximumPitchP95Degrees':25.0}",
    "raw=module.measurement(tracks,targets,'a'*64,'b'*64,policy)[0]",
    "print(json.dumps({'bilabialClosureF1':raw['bilabialClosureF1']}))",
  ]);

  expect(result.bilabialClosureF1).toBe(1);
});

runnerIt("masks a frame in the real tracking branch when the second-face detector fires", () => {
  const result = runProbe([
    "import sys,types",
    "class FakeCapture:",
    "    def __init__(self,*_args): self.reads=0",
    "    def isOpened(self): return True",
    "    def read(self):",
    "        if self.reads>=2: return False,None",
    "        self.reads+=1",
    "        return True,np.zeros((16,16,3),dtype=np.uint8)",
    "    def release(self): pass",
    "class Options:",
    "    def __init__(self,**kwargs): self.num_faces=kwargs['num_faces']",
    "class Landmarker:",
    "    def __init__(self,num_faces): self.num_faces=num_faces",
    "    def __enter__(self): return self",
    "    def __exit__(self,*_args): return False",
    "    def detect_for_video(self,_image,_timestamp):",
    "        count=2 if self.num_faces==2 else 1",
    "        return types.SimpleNamespace(face_landmarks=[[] for _ in range(count)])",
    "class Factory:",
    "    @staticmethod",
    "    def create_from_options(options): return Landmarker(options.num_faces)",
    "mp=types.ModuleType('mediapipe')",
    "mp.__path__=[]",
    "mp.Image=lambda **kwargs: kwargs",
    "mp.ImageFormat=types.SimpleNamespace(SRGB='srgb')",
    "tasks=types.ModuleType('mediapipe.tasks')",
    "tasks.__path__=[]",
    "mp_python=types.ModuleType('mediapipe.tasks.python')",
    "mp_python.__path__=[]",
    "mp_python.BaseOptions=lambda **kwargs: kwargs",
    "vision=types.ModuleType('mediapipe.tasks.python.vision')",
    "vision.FaceLandmarkerOptions=Options",
    "vision.FaceLandmarker=Factory",
    "vision.RunningMode=types.SimpleNamespace(VIDEO='video')",
    "mp.tasks=tasks",
    "tasks.python=mp_python",
    "mp_python.vision=vision",
    "sys.modules['mediapipe']=mp",
    "sys.modules['mediapipe.tasks']=tasks",
    "sys.modules['mediapipe.tasks.python']=mp_python",
    "sys.modules['mediapipe.tasks.python.vision']=vision",
    "module.cv2.VideoCapture=FakeCapture",
    "module.cv2.cvtColor=lambda frame,_code: frame",
    "tracks=module.track_face(pathlib.Path('/tmp/fake.mp4'),pathlib.Path('/tmp/face.task'),[0.0,0.04])",
    "print(json.dumps({'tracked':tracks['tracked'].tolist(),'mouthTracked':tracks['mouthTracked'].tolist(),'multi':tracks['multi'].tolist(),'openingNaN':np.isnan(tracks['opening']).tolist()}))",
  ]);

  expect(result).toEqual({
    tracked: [false, false],
    mouthTracked: [false, false],
    multi: [true, true],
    openingNaN: [true, true],
  });
});

runnerIt("abstains for unknown phones, weak mouth tracking, and multiple faces", () => {
  const result = runProbe([
    "count=96",
    "times=(np.arange(count,dtype=np.float64)+0.5)/24.0",
    "target=np.tile(np.asarray([0.0,0.25,0.55,1.0,0.45,0.25],dtype=np.float64),16)",
    "bilabial=target==0.0",
    "rounded=target==0.45",
    "speech=np.ones(count,dtype=np.bool_)",
    "opening=0.05+target*0.1",
    "closure=np.where(bilabial,0.9,0.1)",
    "tracks={'times':times,'opening':opening,'rounding':rounded.astype(np.float64),'closure':closure,'blur':np.full(count,100.0),'yaw':np.full(count,4.0),'pitch':np.full(count,3.0),'tracked':np.ones(count,dtype=np.bool_),'mouthTracked':np.ones(count,dtype=np.bool_),'multi':np.zeros(count,dtype=np.bool_)}",
    "targets={'opening':target,'bilabial':bilabial,'rounded':rounded.astype(np.float64),'speech':speech,'known':np.ones(count,dtype=np.bool_),'coverage':1.0,'unknown':[]}",
    "policy={'minimumSampledFrames':24,'minimumUsableDurationSeconds':1.0,'minimumFaceTrackCoverage':0.8,'minimumMouthTrackCoverage':0.8,'maximumMultiFaceFrameRatio':0.05,'minimumPhoneCoverage':0.9,'requireNoUnknownPhones':True,'minimumMedianBlurVariance':20.0,'maximumYawP95Degrees':35.0,'maximumPitchP95Degrees':25.0}",
    "unknown_targets={**targets,'coverage':0.95,'unknown':['ZZ']}",
    "weak_tracks={**tracks,'mouthTracked':np.arange(count)<10}",
    "multi_tracks={**tracks,'opening':np.full(count,np.nan),'rounding':np.full(count,np.nan),'closure':np.full(count,np.nan),'tracked':np.zeros(count,dtype=np.bool_),'mouthTracked':np.zeros(count,dtype=np.bool_),'multi':np.ones(count,dtype=np.bool_)}",
    "unknown=module.measurement(tracks,unknown_targets,'a'*64,'b'*64,policy)",
    "weak=module.measurement(weak_tracks,targets,'a'*64,'b'*64,policy)",
    "multi=module.measurement(multi_tracks,targets,'a'*64,'b'*64,policy)",
    "print(json.dumps({'unknown':{'detail':unknown[3],'sufficient':unknown[4]},'weak':{'raw':weak[0],'detail':weak[3],'sufficient':weak[4]},'multi':{'raw':multi[0],'detail':multi[3],'sufficient':multi[4]}}))",
  ]);

  expect(result.unknown).toMatchObject({
    sufficient: false,
    detail: expect.stringContaining("unknown phones present"),
  });
  expect(result.weak).toMatchObject({
    sufficient: false,
    detail: expect.stringContaining("mouth track coverage floor not met"),
  });
  expect((result.weak as { raw: { usableDurationSeconds: number } }).raw.usableDurationSeconds)
    .toBeLessThan(1);
  expect(result.multi).toMatchObject({
    sufficient: false,
    detail: expect.stringContaining("multiple-face ceiling exceeded"),
  });
  expect((result.multi as { raw: { faceTrackCoverage: number; mouthTrackCoverage: number } }).raw)
    .toMatchObject({
      faceTrackCoverage: 0,
      mouthTrackCoverage: 0,
    });
});
