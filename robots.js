/** Robot definitions (plain JS so actuators can use mix functions). */
window.ROBOTS_DATA = {
    robots: [
        {
            name: "6 servos",
            actuators: [
                {
                    type: "servo",
                    name: "H1",
                    pin: 23,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520
                },
                {
                    type: "servo",
                    name: "H2",
                    pin: 22,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520
                },
                {
                    type: "servo",
                    name: "H3",
                    pin: 21,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520
                },
                {
                    type: "servo",
                    name: "H4",
                    pin: 19,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520
                },
                {
                    type: "servo",
                    name: "H5",
                    pin: 18,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520
                },
                {
                    type: "servo",
                    name: "H6",
                    pin: 25,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520
                }
            ],
            controlInputs: {},
            sensors: [],
            targets: [],
            pidControllers: []
        },

        {
            name: "new unnamed robot",
            actuators: [],
            controlInputs: {},
            sensors: [],
            targets: [],
            pidControllers: []
        },





        {
            name: "talking head",
            dashboard: "talkingHead",
            startFlow: {
                autoStart: true,
                deferScreenLight: true,
                steps: [
                    {
                        text: "Pair with your robot",
                        button: "Pair",
                        cancelButton: "Cancel",
                        action: "bluetoothPair",
                        busyButton: "Pairing…",
                        skipWhen: "radioReady"
                    },
                    {
                        text: "Set your phone to max brightness",
                        button: "Done",
                        skipWhen: "radioReady"
                    },
                    {
                        text: "Turn up the volume",
                        button: "Done"
                    },
                    {
                        text: "Put your phone behind the robot's forehead",
                        button: "Done"
                    }
                ]
            },
            bodyPlan: "A face with one sevro for mouth and one for eye yaw",
            controlPlan:
                "Eyes track BlazeFace/MoveNet nose x ~70% of the time; otherwise random glances with held positions. Games: Menu / Simon Says Basic (local MoveNet + pre-recorded Austin clips) / Simon Says Advanced (pose countdown) / Philosophy / 20 Questions / Fortune Teller. Lean in to speak on conversation games. Groq Orpheus or Gemini TTS / Mp3 → audioPlayer → audioMouthFilter → mouth servo.",
            actuators: [
                {
                    type: "servo",
                    name: "mouth",
                    pin: 23,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520,
                    mix: ({ processing }) => (Number(processing.audioMouthFilter?.output) || 0) * 1000 + 1000
                },
                {
                    type: "servo",
                    name: "eye yaw",
                    pin: 22,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520,
                    mix: (() => {
                        const TRACK_PROB = 0.7;
                        const RANDOM_JITTER_PROB = 0.05;
                        const TRACK_HOLD_MS = [800, 3500];
                        const RANDOM_HOLD_MS = [400, 1800];
                        const NOSE_SCORE_MIN = 0.3;

                        let mode = "track";
                        let modeUntil = 0;
                        let randomUs = 1500;

                        const randMs = ([lo, hi]) => lo + Math.random() * (hi - lo);

                        const resolveServoRange = (robot) => {
                            const servo =
                                robot?.actuators?.find(
                                    (a) => String(a?.name || "").toLowerCase() === "eye yaw"
                                ) || null;
                            return {
                                minUs: Number.isFinite(servo?.minMicroseconds)
                                    ? servo.minMicroseconds
                                    : 1000,
                                maxUs: Number.isFinite(servo?.maxMicroseconds)
                                    ? servo.maxMicroseconds
                                    : 2000
                            };
                        };

                        const pickRandomUs = (minUs, maxUs) =>
                            minUs + Math.random() * (maxUs - minUs);

                        return ({ processing, robot }) => {
                            const poses = processing.computervision?.poses;
                            const keypoints = poses?.[0]?.keypoints;
                            // Nose from active vision model (BlazeFace or MoveNet).
                            const nose = Array.isArray(keypoints)
                                ? keypoints.find(
                                      (kp) => String(kp?.name || "").toLowerCase() === "nose"
                                  )
                                : null;
                            const hasNose = !!(
                                nose &&
                                Number.isFinite(nose.x) &&
                                (nose.score || 0) >= NOSE_SCORE_MIN
                            );
                            const { minUs, maxUs } = resolveServoRange(robot);
                            const now = Date.now();

                            if (now >= modeUntil) {
                                if (hasNose && Math.random() < TRACK_PROB) {
                                    mode = "track";
                                    modeUntil = now + randMs(TRACK_HOLD_MS);
                                } else {
                                    mode = "random";
                                    randomUs = pickRandomUs(minUs, maxUs);
                                    modeUntil = now + randMs(RANDOM_HOLD_MS);
                                }
                            }

                            if (mode === "random") {
                                if (Math.random() < RANDOM_JITTER_PROB) {
                                    randomUs = pickRandomUs(minUs, maxUs);
                                }
                                return randomUs;
                            }

                            if (hasNose) {
                                const xRaw = Math.max(0, Math.min(1, Number(nose.x)));
                                // Camera preview is mirrored; invert so eyes follow the person on screen.
                                const x = xRaw; // 1 - xRaw
                                return minUs + x * (maxUs - minUs);
                            }

                            if (Math.random() > 0.95) return pickRandomUs(minUs, maxUs);
                        };
                    })()
                }
            ],
            sensors: [
                "microphone",
                { type: "camera", mirror: true }
            ],
            processing: [
                { type: "audioPlayer", delayMs: 200},
                { type: "audioMouthFilter", input: "audioPlayer", threshold: 0.01, gain: 20 },
                {
                    type: "computervision",
                    on: true,
                    model: "blazeface",
                    frequencyHz: 15,
                    name: "Computer vision"
                }
            ],
            defaultMode: "menu",
            modes: {
                menu: {
                    label: "Menu",
                    game: "menuMode",
                    priceCents: 0,
                    currency: "aud",
                    free: true,
                    computervisionModel: "blazeface"
                },
                simonSaysPoseMatch: {
                    label: "Simon Says Basic",
                    game: "simonSaysPoseMatch",
                    endCondition: "gameFinished",
                    computervisionModel: "movenet"
                },
                simonSaysAi: {
                    label: "Simon Says Advanced",
                    promptTemplate: "promptTemplates/simonSaysPrompt.txt",
                    priceCents: 200,
                    currency: "aud",
                    endCondition: "gameFinished",
                    aiBudgetCents: 50,
                    continuePriceCents: 200,
                    computervisionModel: "blazeface"
                },
                philosophy: {
                    label: "Philosophy",
                    promptTemplate: "promptTemplates/philosophyPrompt.txt",
                    priceCents: 200,
                    currency: "aud",
                    endCondition: "manualOrTimeout",
                    aiBudgetCents: 50,
                    continuePriceCents: 200,
                    computervisionModel: "blazeface"
                },
                twentyQuestions: {
                    label: "20 Questions",
                    promptTemplate: "promptTemplates/20QuestionsPrompt.txt",
                    priceCents: 200,
                    currency: "aud",
                    endCondition: "gameFinished",
                    aiBudgetCents: 50,
                    continuePriceCents: 200,
                    computervisionModel: "blazeface"
                },
                fortuneTeller: {
                    label: "Fortune Teller",
                    promptTemplate: "promptTemplates/fortuneTellerPrompt.txt",
                    priceCents: 200,
                    currency: "aud",
                    endCondition: "manualOrTimeout",
                    aiBudgetCents: 50,
                    continuePriceCents: 200,
                    computervisionModel: "blazeface"
                }
            },
            agentInterface: {
                name: "Chat agents",
                voiceOn: true,
                sendCameraImage: false,
                shortTermMemory: "",
                defaultBaseUrl: "https://api.groq.com/openai/v1",
                transcriptionModel: "whisper-large-v3",
                cameraCaptureMaxEdge: 960,
                cameraCaptureJpegQuality: 0.85,
                promptTemplates: [
                    { name: "Simon Says Advanced", path: "promptTemplates/simonSaysPrompt.txt" },
                    { name: "Philosophy", path: "promptTemplates/philosophyPrompt.txt" },
                    { name: "20 Questions", path: "promptTemplates/20QuestionsPrompt.txt" },
                    { name: "Fortune Teller", path: "promptTemplates/fortuneTellerPrompt.txt" }
                ],
                agents: [
                    {
                        name: "Groq — Qwen 3.6 27B",
                        baseUrl: "https://api.groq.com/openai/v1",
                        chatPath: "/chat/completions",
                        model: "qwen/qwen3.6-27b",
                        transcriptionModel: "whisper-large-v3",
                        temperature: 0.3,
                        maxTokens: 96,
                        reasoningEffort: "none"
                    },
                    {
                        name: "Gemini — audio turn (AI Studio)",
                        provider: "gemini",
                        voiceMode: "geminiAudioTurn",
                        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                        model: "gemini-3.6-flash",
                        speechModel: "gemini-3.1-flash-tts-preview",
                        temperature: 0.3,
                        maxTokens: 256
                    },
                    {
                        name: "OpenAI-compatible (example)",
                        baseUrl: "https://api.openai.com/v1",
                        chatPath: "/chat/completions",
                        model: "gpt-4o-mini",
                        transcriptionModel: "whisper-1",
                        temperature: 0.7
                    }
                ]
            }
        },







        {
            name: "rover1",
            bodyPlan: "A rover with two wheels and a camera",
            controlPlan:
                "Move by placing an object in your camera view at a desired horizontal position: x is 0 to 1 (0.5 = center).",
            actuators: [
                {
                    type: "servo",
                    name: "left wheel",
                    pin: 4,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520,
                    mix: ({ controlInputs }) => (-controlInputs.speed + controlInputs.yawSpeed) * 500 + 1500
                },
                {
                    type: "servo",
                    name: "right wheel",
                    pin: 5,
                    homeMicroseconds: 1500,
                    minMicroseconds: 1000,
                    maxMicroseconds: 2000,
                    deadbandMicrosecondsMin: 1480,
                    deadbandMicrosecondsMax: 1520,
                    mix: ({ controlInputs }) => (+controlInputs.speed + controlInputs.yawSpeed) * 500 + 1500
                }
            ],
            controlInputs: {
                speed: { name: "speed", min: -1, max: 1, home: 0 },
                yawSpeed: { name: "yaw speed", min: -1, max: 1, home: 0 }
            },
            joysticks: [
                {
                    name: "speed / yaw",
                    x: "yawSpeed",
                    y: "speed"
                }
            ],
            sensors: ["camera", "microphone", "gyro"],
            processing: [
                { type: "groqvision", frequencyHz: 0.2, model: "qwen/qwen3.6-27b" },
                {
                    type: "computervision",
                    on: true,
                    model: "opencv",
                    frequencyHz: 10,
                    groqFeedType: "groqvision",
                    maxNumBoxes: 40,
                    minScore: 0.2,
                    groqRefreshMs: 5000,
                    cocoRefreshMs: 500,
                    forgetStaleMs: 1000,
                    name: "Computer vision"
                },
                {
                    type: "speechToText",
                    name: "Speech to text",
                    on: true,
                    VAD: "webRTC",
                    trigger: "hey robot",
                    confirmation: "listening",
                    terminator: "not talking 2000ms",
                    stt: "browser-webspeech"
                }
            ],
            targets: [],
            objectFilters: [
                {
                    name: "mainObjectFilter",
                    on: true,
                    dataFeed: "computervision",
                    filters: ["flow"],
                    minScore: 0.1,
                    strategy: "largest",
                    outputRange: "zeroToOne",
                    invertX: false,
                    frequencyHz: "dataFeed"
                }
            ],
            pidControllers: [
                {
                    name: "yaw object tracker PID",
                    on: true,
                    feedback: "mainObjectFilter.result.output.x",
                    controlInput: "yawSpeed",
                    goal: 0.5,
                    kp: -0.1,
                    ki: 0.0,
                    kd: -0.01,
                    frequencyHz: "feedback"
                },
                {
                    name: "y object tracker PID",
                    on: true,
                    feedback: "mainObjectFilter.result.center.y",
                    controlInput: "speed",
                    goal: 0.9,
                    kp: -0.2,
                    ki: 0.0,
                    kd: -0.01,
                    frequencyHz: "feedback"
                }
            ],
            strategies: {
                frequencyHz: 10,
                defaultStrategy: "trackWithoutSearch",
                searchPanYaw: 0.02,
                frameSearchGraceMs: 10000,
                panSearchGraceMs: 30000,
                changeFilterGraceMs: 10000
            },
            stateMachine: [
                {
                    name: "cameraView",
                    path: "agentInterface.currentCameraImageUrl",
                    description:
                        "Latest camera frame"
                },
                {
                    name: "gyroYaw",
                    path: "sensors.gyro.yaw",
                    description:
                        "Phone yaw in degrees"
                }
                //{name: "objects seen", path: "processing.computervision.results", description: "Tracks in the camera feed. Each bbox is normalized: x and width are 0–1 fractions of frame width, y and height are 0–1 fractions of frame height. Field bboxUnit is \"normalized01\"."},
            ],
            actions: [
                {
                    actionName: "shift",
                    functionPath: "strategies.shiftCameraFeature",
                    actionArgsHint: '{"from":47,"to":59}',
                    type: "float",
                    min: 0,
                    max: 1,
                    increment: 0.01,
                    usage:
                        "Intersection labels only: \"from\" and \"to\" are 11–99 (digits 1–9 each); split digits → y = first/10, x = second/10. Same encoding as the numbers drawn on the camera image."
                },
                //{actionName: "filter", functionPath: "objectFilters.mainObjectFilter.setFilters", actionArgsHint: '["cup"], ["door","doorway"], ["human","person","face","head"]', usage: "Set filters for objects already in your vision to track them, else set objects to pan and search for. Value may be a comma-separated string, a JSON array of label strings, or objects (e.g. type label/bbox)." },
                //{actionName: "x", functionPath: "pidControllers.yaw object tracker PID.setGoal", actionArgsHint: "0, 0.25, 0.5, 0.75, 1", type: "float", min: 0, max: 1, increment: 0.05, usage: "Horizontal aim for the tracked object: 0.5 centers it in the view; 0 and 1 are the left and right extremes (values are 0–1, same units as filter output x)." }
            ],
            actionExamples: [
                {
                    actions: [{ filter: ["person", "human", "face", "head"]}, { x: 0.5 }],
                    message: "I have just been turned on so I will face a person."
                },
                {
                    actions: [{ filter: ["door", "doorway"]}, { x: 0.5 }],
                    message: "I don't see a person so I will look for a door to go through."
                }
            ],
            agentInterface: {
                name: "Chat agents",
                voiceOn: true,
                sendCameraImage: true,
                shortTermMemory: "",
                defaultBaseUrl: "https://api.groq.com/openai/v1",
                transcriptionModel: "whisper-large-v3",
                cameraCaptureMaxEdge: 960,
                cameraCaptureJpegQuality: 0.85,
                promptTemplates: [
                    { name: "Image + shift prompt", path: "promptTemplates/introImagePrompt.txt" }
                ],
                agents: [
                    {
                        name: "Groq — Qwen 3.6 27B",
                        baseUrl: "https://api.groq.com/openai/v1",
                        chatPath: "/chat/completions",
                        model: "qwen/qwen3.6-27b",
                        transcriptionModel: "whisper-large-v3",
                        temperature: 0.2,
                        maxTokens: 768,
                        reasoningEffort: "none",
                        responseFormat: { type: "json_object" }
                    },
                    {
                        name: "Gemini — audio turn (AI Studio)",
                        provider: "gemini",
                        voiceMode: "geminiAudioTurn",
                        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                        model: "gemini-3.6-flash",
                        speechModel: "gemini-3.1-flash-tts-preview",
                        temperature: 0.2,
                        maxTokens: 768,
                        responseFormat: { type: "json_object" }
                    },
                    {
                        name: "OpenAI-compatible (example)",
                        baseUrl: "https://api.openai.com/v1",
                        chatPath: "/chat/completions",
                        model: "gpt-4o-mini",
                        transcriptionModel: "whisper-1",
                        temperature: 0.7
                    }
                ]
            },
            transmitter: "wifi"
        }
    ]
};
