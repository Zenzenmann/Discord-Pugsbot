# Discord-Pugsbot
Bot for randomized teams and for moving people in vc's


After downloading move all the files in one folder


Create a bot on the Discord developer portal and get your Application_ID and the Token required for the bot 

[const TOKEN = 'BOT TOKEN HERE';] [const CLIENT_ID = 'APPLICATION_ID HERE';]


Use https://discord.com/oauth2/authorize?client_id=REPLACEWITHCLIENT_ID&permissions=268435456&scope=bot+applications.commands
To invite the bot to your Server with the permissions to move people and change  theire roles to apply spectator-mode


Fill in your pathname of the folder in the start.bat


Fill in the Token and the Application_ID from your bot into the index.js


Fill in the Server_ID from the Server which you want to use the bot in [await rest.put(Routes.applicationGuildCommands(CLIENT_ID, 'SERVER_ID HERE'), { body: commands });]


Run the start.bat and the bot should be running on your machine


The commands at the time are:

/move [Name] [channel]                          | move one member to a channel

/moveall [channel]                              | move all members from one channel to another

/randomteams [lobby_vc] [Team1_vc] [Team2_vc]   | randomize equaly sized teams from the lobby into 2 different vc's, if unequal then team2 gets +1 player 

/done                                           | used after /randomteams when the match is over to bring everyone back to the lobby vc

/randomteams2 [lobby+Team1_vc] [Team2_vc]       | moves half the people from the lobby_vc into team2 (useful when more than 10 people should be moved since discord doesnt like moving alot of people at once)

/done2                                          | used after /randomteams2 when the match is over to bring everyone back to the lobby/team1 vc

/spectator [Name]                               | used to give a role named spectator and excludes them from the /randomteams, /randomteams2, /done and /done2 
command if the user already has the spectator role then the spectator role gets removed
