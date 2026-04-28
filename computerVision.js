class ComputerVision {
    constructor() {
        //informers = CocoAiModel, lamma4
        //seenObjects = {objectId: {bbox: [x, y, width, height], label: "objectLabel", score: 0.95}} plus any identification data needed to match new found objects.
        //filters = {}// filter by name, color, size, shape, etc
    }

    detectObjects(){}//finds general unlabeledbounding boxes
    classifyObject(informer){}//receives informer result
}

module.exports = ComputerVision;