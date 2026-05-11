/** Robot definitions (plain JS so actuators can use mix functions). */
window.ROBOTS_DATA = {
    robots: [
        {
            name: "new unnamed robot",
            actuators: [],
            controlInputs: {},
            sensors: [],
            targets: [],
            pidControllers: []
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
            sensors: ["camera", "microphone"],
            processing: [
                { type: "groqvision", frequencyHz: 0.2, model: "meta-llama/llama-4-scout-17b-16e-instruct" },
                {
                    type: "computervision",
                    on: true,
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
                    feedback: "mainObjectFilter.result.bbox.y",
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
                        "Latest camera frame as a data URL (full value omitted in prompt text; the same frame is attached as an image on the current chat turn only)."
                }
                //{name: "objects seen", path: "processing.computervision.results", description: "Tracks in the camera feed. Each bbox is normalized: x and width are 0–1 fractions of frame width, y and height are 0–1 fractions of frame height. Field bboxUnit is \"normalized01\"."},
            ],
            actions: [
                {
                    actionName: "shift",
                    functionPath: "strategies.shiftCameraFeature",
                    actionArgsHint: '{"fromX":0.8,"fromY":0.5,"toX":0.5,"toY":0.9}',
                    type: "float",
                    min: 0,
                    max: 1,
                    increment: 0.01,
                    usage: "Pick a feature at normalized fromX/fromY (0–1), then set yaw PID goal to toX and forward/speed PID goal to toY."
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
                        name: "Groq — Llama 4 Scout",
                        baseUrl: "https://api.groq.com/openai/v1",
                        chatPath: "/chat/completions",
                        model: "meta-llama/llama-4-scout-17b-16e-instruct",
                        transcriptionModel: "whisper-large-v3",
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
