
/*var openingPhrase = "Hello, Let's play a game of Simon Says!"
var keyPhrase = "Simon Says";
var incorrectPosePhrase = "That doesn't look right"
var simonDidNotSayPhrase = "Hey, Simon did not say to do it. Got you. That's a point for me"
var wrongPosePhrase = "Wrong pose. Try again."
var simonSaid = false;


//1) say opening phrase
//2)Pick random pose different to last pose
//3) Set simonSaid = true with 0.8 probability.
//4)If simonSaid is true, say "Simon Says".
//5)Say command
//6)Wait for 1 second
//7)Check if pose is correct
//8)
If (simonSaid === true){
    if(pose is correct){{ say nothing then go to step 2 }
    else if (pose is wrong){say the wrong pose phrase then go to step 4}
}
else if (simonSaid === false){
    if(pose is correct){{ say simonDidNotSayPhrase then go to step 2 }
    else if (pose is incorrect){{go to step 2}
}
}, repeat from step 2
//9)If incorrect, say the wrong pose phrase
//10)If correct, say "Correct" and end game
//11)End game




poses = [
    {command: "put your hands on your head", 
    poseNodes: ["leftHand, rightHand, nose"]},
    {command: "put one hand up high", 
    poseNodes: ["leftHand||rightHand y greater than nose y"]},
    {command: "put two hand up", 
    poseNodes: ["leftHand & rightHand y greater than nose y"]}
]
*/



//Ai version
//Use LLama. 
//send default prompt "You are simon in a game of simon says. Play so that you don't say Simon says roughly 25% of the time. I will send you an image for you to check the players poses."