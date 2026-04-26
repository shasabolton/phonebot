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
                { type: "coco", frequencyHz: 10, maxNumBoxes: 30, minScore: 0.25 },
                { type: "tracker", frequencyHz: 10 },
                { type: "groqvision", frequencyHz: 0.2, model: "meta-llama/llama-4-scout-17b-16e-instruct" },
                {
                    type: "objectmatcher",
                    frequencyHz: 10,
                    groqFeedType: "groqvision",
                    groqRefreshMs: 5000,
                    name: "Object matcher (Groq + flow)"
                }
            ],
            targets: [],
            trackers: [
                {
                    name: "cocoTracker",
                    dataFeed: "objectmatcher",
                    filters: ["cup"],
                    minScore: 0.25,
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
            transmitter: "wifi"
        }
    ]
};
