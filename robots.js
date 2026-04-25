/** Robot definitions (plain JS so actuators can use mix functions). */
window.ROBOTS_DATA = {
    robots: [
        {
            name: "new unnamed robot",
            actuators: [],
            inputs: {},
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
                    mix: ({ inputs }) => (-inputs.speed + inputs.direction) * 500 + 1500
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
                    mix: ({ inputs }) => (+inputs.speed + inputs.direction) * 500 + 1500
                }
            ],
            inputs: {
                speed: { name: "speed", min: -1, max: 1, home: 0 },
                direction: { name: "direction", min: -1, max: 1, home: 0 }
            },
            joysticks: [
                {
                    name: "speed / direction",
                    x: "direction",
                    y: "speed"
                }
            ],
            sensors: ["camera"],
            aiModels: [{ type: "coco", frequencyHz: 10 }],
            targets: [],
            trackers: [
                {
                    name: "cocoTracker",
                    dataFeed: "coco",
                    filters: ["cup"],
                    minScore: 0.4,
                    strategy: "largest",
                    outputRange: "minusOneToOne",
                    invertX: false,
                    frequencyHz: "dataFeed"
                }
            ],
            pidControllers: [
                {
                    name: "direction object tracker PID",
                    feedback: "cocoTracker.result.output.x",
                    input: "direction",
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
