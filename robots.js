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
                "Move by placing an object in your camera view at a desired x location.",
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
                    stt: "browser-webspeech",
                    agentTranscribeFallback: false
                }
            ],
            targets: [],
            objectFilters: [
                {
                    name: "mainObjectFilter",
                    on: true,
                    dataFeed: "computervision",
                    filters: ["cup"],
                    minScore: 0.1,
                    strategy: "largest",
                    outputRange: "minusOneToOne",
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
                    goal: 0,
                    kp: -0.05,
                    ki: 0.0,
                    kd: -0.01,
                    frequencyHz: "feedback"
                }
            ],
            strategies: {
                frequencyHz: 10,
                defaultStrategy: "trackWithoutSearch",
                searchPanYaw: 0.2,
                frameSearchGraceMs: 2000,
                panSearchGraceMs: 10000,
                changeFilterGraceMs: 10000
            },
            stateMachine: [
                 {name: "objects seen", path: "processing.computervision.results", description:"the current objects detected in your camera feed"},
                ],
            actions: [
                {actionName: "filter", functionPath: "objectFilters.mainObjectFilter.setFilters", actionArgsHint: '["cup"], ["door","doorway"], ["human","person","face","head"]', usage: "Set filters for objects already in your vision to track them, else set objects to pan and search for. Value may be a comma-separated string, a JSON array of label strings, or objects (e.g. type label/bbox)." },
                {actionName: "x", functionPath: "pidControllers.yaw object tracker PID.setGoal", actionArgsHint: "0, 1, -1, -0.5, 0.5", type: "float", min: -1, max: 1, increment:0.1, usage: "set goal to 0 to center an object. Set it between -1 and 1 to move it to the side. Moving an object from one side of the screen to the other can be used as a way to pan your view to explore."}
            ],
            actionExamples: [
                {
                    actions: [{ filter: ["person", "human", "face", "head"]}, {x: 0 }],
                    message: "I have just been turned on so I will face a person."
                },
                {
                    actions: [{ filter: ["door", "doorway"]}, {x: 0 }],
                    message: "I don't see a person so I will look for a door to go through."
                }
            ],
            agentInterface: {
                name: "Chat agents",
                voiceOn: true,
                shortTermMemory: "",
                defaultBaseUrl: "https://api.groq.com/openai/v1",
                transcriptionModel: "whisper-large-v3",
                promptTemplates: [
                    { name: "Introduction prompt", path: "promptTemplates/introductionPrompt.txt" }
                ],
                agents: [
                    {
                        name: "Groq — Llama 4 Scout",
                        baseUrl: "https://api.groq.com/openai/v1",
                        chatPath: "/chat/completions",
                        model: "meta-llama/llama-4-scout-17b-16e-instruct",
                        transcriptionModel: "whisper-large-v3"
                    },
                    {
                        name: "OpenAI-compatible (example)",
                        baseUrl: "https://api.openai.com/v1",
                        chatPath: "/chat/completions",
                        model: "gpt-4o-mini",
                        transcriptionModel: "whisper-1"
                    }
                ]
            },
            transmitter: "wifi"
        }
    ]
};
