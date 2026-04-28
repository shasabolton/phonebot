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
            controlPlan:"A pid controller receives feedback from the filtered bounding boxes detected in the camera feed and sets the yaw speed accordingly. Set tracking filter to target different objects. eg cup, door, human etc",
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
            sensors: ["camera"],
            aiModels: [
                {
                    type: "coco",
                    frequencyHz: 10,
                    maxNumBoxes: 40,
                    minScore: 0.2,
                    trackTimeoutMs: 3000,
                    matchIouThreshold: 0.2
                },
                { type: "tracker", frequencyHz: 10 },
                { type: "groqvision", frequencyHz: 0.2, model: "meta-llama/llama-4-scout-17b-16e-instruct" },
                {
                    type: "objectmatcher",
                    frequencyHz: 10,
                    groqFeedType: "groqvision",
                    cocoFeedType: "coco",
                    groqRefreshMs: 5000,
                    cocoRefreshMs: 500,
                    name: "Object matcher (Groq + flow)"
                }
            ],
            targets: [],
            objectFilters: [
                {
                    name: "cocoTracker",
                    dataFeed: "coco",
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
                    feedback: "cocoTracker.result.output.x",
                    controlInput: "yawSpeed",
                    goal: 0,
                    kp: -0.12,
                    ki: 0.0,
                    kd: -0.01,
                    frequencyHz: "feedback"
                }
            ],
            state: ["goal", "objectFilters.cocoTracker.filters", "aiModels.coco.results"],
            actions: [
                {actionName: "setTrackingFilter", functionPath: "objectFilters.cocoTracker.setFiltersFromString", actionArgsHint: "cup, door, human etc" },
                {actionName: "setYawTrackingGoal", functionPath: "pidControllers.yawObjectTrackerPID.setGoal", actionArgsHint: "0, 1, -1", usage: "set goal to 0 to center an object. Set it between -1 and 1 to move it to the side. Moving an object from one side of the screen to the other can be used as a way to pan your view to explore."} // uses groq vision model
            ],
            agentInterface: {
                name: "Chat agents",
                defaultBaseUrl: "https://api.groq.com/openai/v1",
                promptTemplates: [
                    { name: "Introduction prompt", path: "promptTemplates/introductionPrompt.txt" }
                ],
                agents: [
                    {
                        name: "Groq — Llama 4 Scout",
                        baseUrl: "https://api.groq.com/openai/v1",
                        chatPath: "/chat/completions",
                        model: "meta-llama/llama-4-scout-17b-16e-instruct"
                    },
                    {
                        name: "OpenAI-compatible (example)",
                        baseUrl: "https://api.openai.com/v1",
                        chatPath: "/chat/completions",
                        model: "gpt-4o-mini"
                    }
                ]
            },
            transmitter: "wifi"
        }
    ]
};
