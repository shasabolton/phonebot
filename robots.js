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
                    pin: 5,
                    homeAngle: 90,
                    minAngle: 0,
                    maxAngle: 180,
                    mix: ({ inputs }) => (inputs.speed - inputs.direction) * 90 + 90
                },
                {
                    type: "servo",
                    name: "right wheel",
                    pin: 4,
                    homeAngle: 90,
                    minAngle: 0,
                    maxAngle: 180,
                    mix: ({ inputs }) => (-inputs.speed + inputs.direction) * 90 + 90
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
            sensors: [],
            targets: [],
            pidControllers: [],
            transmitter: "wifi"
        }
    ]
};
