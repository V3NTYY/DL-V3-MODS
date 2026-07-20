### Discord
* Join this discord to get updates on these mods/this repo/offer feedback, bugs,
 requests, etc...
* [discord.gg/AVtXYP8V8J](https://discord.gg/AVtXYP8V8J)
# What is this Repo?
* A collection of mods I've created, combined or amalgamated that push Deadlock's Panorama to its limit. I would upload to GB but unfortunately these would not stay up.

* **__NOTICE__: These are ethically gray mods.** You won't get banned unless Valve says otherwise, as these work purely using Panorama. But expect these to probably get patched out silently in the near future.
    * _How would they patch this?_ Really simple. Change hero icon button_maps on the minimap to native canvas rendering rather than exposing them.

* Everything in this Repo is a work-in progress, and is not ready for me to release yet (will have bugs and work inconsistently, or otherwise won't look the way I intend)

## What mods are included?
* _LastSpot_, _Soul Advantage_, and a ripped/updated minimap mod from Hanturaya. All of these mods for the time being though are amalgamated into a single mod, LastSpot.

## How do I use LastSpot?
* Press F9 and open the menus, at the start of a match you assign ID's to hero icon's.
* Currently, a ripped/updated version of Hanturaya's minimap mod is merged with the current version of LastSpot. If you don't have a minimap mod already, press F8 and you can configure one. If you do have a minimap mod already, test with placing it in the mod priority before LastSpot.

## What is the Soul Advantage mod?
* This is another mod I created that is currently bundled with LastSpot. Soul Advantage, is simply the net spent souls you have relative to every player in a lobby, giving you an exact idea of how much up you are on a player.
* A +- value displayed above a hero portrait shows your relative spent souls to another hero (e.g. if you have spent 6.4k, and an enemy Billy has spent 4.8k, the value above the Billy would display -1.6k, since they are 1.6k souls down compared to your current spent souls)
* RGB coloring dynamically applies to the Soul Advantage HUD as well based on the % difference that another hero is up/down relative to you. Bright red means huge disparity that works against you, while green indicates a huge advantage that works for you.
* Basically, green GOOD and FIGHT; red BAD and NO FIGHT for the cavemen out there.

## How do I use Soul Advantage?
* It works automatically/triggers after the 60sec LastSpot scan. If you want to configure some of its HUD elements, use F10 and play around.

## Mod conflicts?
* _LastSpot_ ships several vanilla modifications (hud.xml, hud.css, etc...). Anything else that does, if you make a request in the discord I can create a merged version for you. No _QOL-Lock_.

* _QOL-Lite_ (https://github.com/dacooderr/QOL-Lite) pairs well with this mod -- including its new minimap update. I highly recommend to download and pair it w/ LastSpot. Place it before LastSpot in mod order.

* You can use Topbar with this mod, it's actually recommended for now -- I haven't tested a live match w/o it and the live vs private match functionality VERY MUCH is inconsistent/differs due to how Topbar is loaded in a private match vs. live.

## Where to place it?
* Generally, at the top of the mod order. If pairing with _QOL-Lite_, place QOL-Lite prior to it.

## Known Bugs? (Report in Discord if you find one)
* Lane-assist functionality sometimes replaces an enemy name with a friendly hero name (attempted to fix via 60sec scan rather than 30sec scan)

* Cannot manually type hero name if Lane-assist not functioning
