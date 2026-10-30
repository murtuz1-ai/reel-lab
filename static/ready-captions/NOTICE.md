# Ready captions — source and license notice

This small Reel Lab page is an original local interface that uses only these
upstream parts of [TSCaps](https://github.com/francozanardi/tscaps):

- `@tscaps/engine` browser renderer — MIT; see `LICENSE-TSCAPS-ENGINE-MIT.txt`.
- The twelve CSS templates listed by `../vendor/tscaps/manifest.json` — MIT;
  see `LICENSE-TSCAPS-TEMPLATES-MIT.txt` and the adjacent source trace.

The upstream TSCaps Studio application is **not** included or imported. It has
a different AGPL-3.0 license.

## Cyrillic font coverage

Fonts in `fonts/` are local SIL Open Font License 1.1 webfonts. The licenses
are retained in `licenses/`. Some upstream display fonts do not publish
Cyrillic glyphs; their Cyrillic unicode ranges are paired with an OFL fallback
under the same family name. This preserves the source template's placement and
animation while keeping Russian captions readable.

## Arabic font coverage

`fonts/ar/` holds subsets of Cairo, Lalezar, Changa and Reem Kufi (SIL Open
Font License 1.1, from github.com/google/fonts; built by
`tools/build_arabic_fonts.py`). `fonts-arabic.css` pairs the Arabic unicode
ranges of every studio font family with Cairo under the same family name, so
Arabic captions render in every style; the four families are also offered as
fonts of their own. The OFL text is in `licenses/OFL-arabic.txt`.

## What this page does

It runs in a current Chrome or Edge browser, locally encodes a selected video
and an existing `.srt` subtitle file through WebCodecs, and exposes a normal
MP4 download. The video and SRT stay on the computer while this page runs.

## Sounds

The sound library in `../sounds/sfx/` (see its `manifest.json`, fields
`source`, `license` and `credits` of every sound) comes from three places:

- **Freesound** (freesound.org) — recordings released by their authors under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (no attribution
  required; the authors are still credited below and in the studio). Trimmed,
  cut into separate takes, loudness-matched and sometimes pitch-shifted; the
  original previews are kept in `sound-sources/freesound/` of the project.
- **Kenney** (kenney.nl) — Interface Sounds, UI Audio, Impact Sounds, Digital
  Audio, Sci-Fi Sounds and RPG Audio, released under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Trimmed,
  loudness-matched and sometimes pitch-shifted; the originals and Kenney's
  licence files are kept in `sound-sources/kenney/` of the project.
- **Reel Lab synthesis** — a few sounds generated from scratch by
  `tools/build_sfx.py` and `tools/sfx_synth.py` (no recordings).

Sounds a user adds in the studio (an uploaded file or a piece cut from a
video) stay in that user's `data/sounds/own/` and are never shipped; the user
is responsible for the rights to them.

Freesound recordings used:

- «bell ding 1.wav» — 5ro4, https://freesound.org/people/5ro4/sounds/611113/ (в студии: Динь)
- «DSLR Camera Click» — akonze, https://freesound.org/people/akonze/sounds/157812/ (в студии: Затвор камеры)
- «cartoon pop or drip» — AlaskaRobotics, https://freesound.org/people/AlaskaRobotics/sounds/221091/ (в студии: Капля)
- «Zipper» — AntumDeluge, https://freesound.org/people/AntumDeluge/sounds/188044/ (в студии: Молния)
- «Beep 1 sec.wav» — austin1234575, https://freesound.org/people/austin1234575/sounds/213795/ (в студии: Цензура «бип»)
- «Laptop Keyboard» — bassboybg, https://freesound.org/people/bassboybg/sounds/346589/ (в студии: Ноутбук)
- «tongue_click.wav» — boulderbuff64, https://freesound.org/people/boulderbuff64/sounds/262301/ (в студии: Цоканье)
- «Balloon Pop / Christmas cracker / Confetti Canno» — Breviceps, https://freesound.org/people/Breviceps/sounds/458398/ (в студии: Лопнул шарик)
- «Plop!» — Breviceps, https://freesound.org/people/Breviceps/sounds/447910/ (в студии: Плюх)
- «Cash Register Fake.wav» — CapsLok, https://freesound.org/people/CapsLok/sounds/184438/ (в студии: Касса)
- «mouthPop_02.wav» — carlSablowEdwards, https://freesound.org/people/carlSablowEdwards/sounds/47498/ (в студии: Поп губами)
- «Heal - Rpg» — colorsCrimsonTears, https://freesound.org/people/colorsCrimsonTears/sounds/562292/ (в студии: Исцеление)
- «Pop Sound» — ConarB13, https://freesound.org/people/ConarB13/sounds/401542/ (в студии: Поп)
- «Woosh (stick swung in the air)» — Dalesome, https://freesound.org/people/Dalesome/sounds/352719/ (в студии: Резкий взмах)
- «ding.wav» — Daphne_in_Wonderland, https://freesound.org/people/Daphne_in_Wonderland/sounds/127149/ (в студии: Динь)
- «Finger Snap» — dastudiospr, https://freesound.org/people/dastudiospr/sounds/496088/ (в студии: Щелчок пальцами)
- «fast simple chop 5.aif» — dave.des, https://freesound.org/people/dave.des/sounds/127197/ (в студии: Резкий взмах)
- «Page Turn» — davidbain, https://freesound.org/people/davidbain/sounds/136778/ (в студии: Перелистывание)
- «Cinematic Impact» — deleted_user_3277771, https://freesound.org/people/deleted_user_3277771/sounds/177242/ (в студии: Подъём и кино-удар)
- «Reverse Crash Cymbal Projection» — deleted_user_7146007, https://freesound.org/people/deleted_user_7146007/sounds/383903/ (в студии: Обратная тарелка)
- «Throwing / Whip Effect» — denao270, https://freesound.org/people/denao270/sounds/346373/ (в студии: Резкий взмах)
- «Pop sound» — deraj, https://freesound.org/people/deraj/sounds/202230/ (в студии: Поп)
- «Cinematic Hit With Horns.wav» — DeVern, https://freesound.org/people/DeVern/sounds/427803/ (в студии: Брааам)
- «Metal Gear Solid Inspired Alert Surprise SFX» — djlprojects, https://freesound.org/people/djlprojects/sounds/413641/ (в студии: Тревога «!»)
- «Mystical Wind Chimes Transition FX» — djlprojects, https://freesound.org/people/djlprojects/sounds/419594/ (в студии: Колокольчики ветра)
- «Coin Flip Shimmer» — dpren, https://freesound.org/people/dpren/sounds/248143/ (в студии: Блеск монетки)
- «punch.wav» — Ekokubza123, https://freesound.org/people/Ekokubza123/sounds/104183/ (в студии: Удар кулаком)
- «Spark» — elliott.klein, https://freesound.org/people/elliott.klein/sounds/189630/ (в студии: Искра)
- «Bubbles.wav» — erkanozan, https://freesound.org/people/erkanozan/sounds/51745/ (в студии: Бульканье)
- «Knocking on Wood Door (1)» — Flem0527, https://freesound.org/people/Flem0527/sounds/629987/ (в студии: Стук в дверь)
- «quick woosh» — florianreichelt, https://freesound.org/people/florianreichelt/sounds/683101/ (в студии: Резкий взмах)
- «Short Success Sound Glockenspiel Treasure Video » — FunWithSound, https://freesound.org/people/FunWithSound/sounds/456965/ (в студии: Успех)
- «Space Swoosh - brighter» — GameAudio, https://freesound.org/people/GameAudio/sounds/220191/ (в студии: Космический пролёт)
- «reverse crash.wav» — genocidalguitar, https://freesound.org/people/genocidalguitar/sounds/110218/ (в студии: Обратная тарелка)
- «bubble1.wav» — Godowan, https://freesound.org/people/Godowan/sounds/235264/ (в студии: Пузырёк)
- «swoosh» — Halgrimm, https://freesound.org/people/Halgrimm/sounds/169867/ (в студии: Мягкий ветер)
- «Punch in the face» — Huminaatio, https://freesound.org/people/Huminaatio/sounds/390462/ (в студии: Удар кулаком)
- «Message Pop Sound» — ImAFoley, https://freesound.org/people/ImAFoley/sounds/537061/ (в студии: Пузырьки на буквы)
- «hotel bell» — iwanPlays, https://freesound.org/people/iwanPlays/sounds/532751/ (в студии: Звонок на стойке)
- «Coin dropping.wav» — Jace, https://freesound.org/people/Jace/sounds/17502/ (в студии: Монеты)
- «ELECTRIC_ZAP_001.wav» — JoelAudio, https://freesound.org/people/JoelAudio/sounds/136542/ (в студии: Электричество)
- «reverse cymbal.wav» — John Rayson, https://freesound.org/people/John Rayson/sounds/23127/ (в студии: Обратная тарелка)
- «Metal Hit Cartoon» — Johnnyfarmer, https://freesound.org/people/Johnnyfarmer/sounds/209771/ (в студии: Бамс)
- «iPhone text type keypress keyboard» — jordanielmills, https://freesound.org/people/jordanielmills/sounds/640365/ (в студии: Клавиатура телефона)
- «Movie Short Swell» — jordivburgel, https://freesound.org/people/jordivburgel/sounds/218354/ (в студии: Нарастание и удар)
- «Movie Swell 2» — jordivburgel, https://freesound.org/people/jordivburgel/sounds/218524/ (в студии: Нарастание и удар)
- «JM_FX_Boom 01a.wav» — Julien_Matthey, https://freesound.org/people/Julien_Matthey/sounds/201571/ (в студии: Бум)
- «Champagne Cork» — KenRT, https://freesound.org/people/KenRT/sounds/392624/ (в студии: Пробка)
- «Typewriter bell & carriage reset» — knufds, https://freesound.org/people/knufds/sounds/345955/ (в студии: Возврат каретки)
- «Crystal Twinkle» — LaurenPonder, https://freesound.org/people/LaurenPonder/sounds/639429/ (в студии: Кристалл)
- «pling sound effect ui interface ding ting sound.» — Leonardmedia.nl, https://freesound.org/people/Leonardmedia.nl/sounds/627794/ (в студии: Плинь)
- «coin object» — Leszek_Szary, https://freesound.org/people/Leszek_Szary/sounds/146723/ (в студии: Монетка)
- «Pen Click» — LexzachGames, https://freesound.org/people/LexzachGames/sounds/431492/ (в студии: Ручка)
- «Page Turn 01» — LilMati, https://freesound.org/people/LilMati/sounds/397548/ (в студии: Перелистывание)
- «Pop 01» — LilMati, https://freesound.org/people/LilMati/sounds/506546/ (в студии: Поп)
- «Correct.mp3» — LittleRainySeasons, https://freesound.org/people/LittleRainySeasons/sounds/335908/ (в студии: Правильно)
- «record_scratch.wav» — ludvique, https://freesound.org/people/ludvique/sounds/71853/ (в студии: Скретч пластинки)
- «Boing 2» — magnuswaker, https://freesound.org/people/magnuswaker/sounds/540790/ (в студии: Боинг)
- «cartoon poppyup appearances -0001.aiff» — martian, https://freesound.org/people/martian/sounds/19284/ (в студии: Появление)
- «classic dizzy take slide whistle.wav» — martian, https://freesound.org/people/martian/sounds/403002/ (в студии: Свисток-горка)
- «classic double swwosh .wav» — martian, https://freesound.org/people/martian/sounds/19312/ (в студии: Двойной вжух)
- «ding2.wav» — MashedTatoes2, https://freesound.org/people/MashedTatoes2/sounds/515643/ (в студии: Динь)
- «typing_phone_02.mp3» — melliug, https://freesound.org/people/melliug/sounds/176066/ (в студии: Тапы по экрану)
- «Electric zap.wav» — michael_grinnell, https://freesound.org/people/michael_grinnell/sounds/512471/ (в студии: Искра)
- «Metallic Whoosh.wav» — MissCellany, https://freesound.org/people/MissCellany/sounds/240640/ (в студии: Металлический свист)
- «cartoon_wink_magic_sparkle.wav» — MLaudio, https://freesound.org/people/MLaudio/sounds/511485/ (в студии: Подмигивание)
- «success_bell» — MLaudio, https://freesound.org/people/MLaudio/sounds/511484/ (в студии: Колокольчики успеха)
- «type writing» — mlekoman, https://freesound.org/people/mlekoman/sounds/320571/ (в студии: Пишущая машинка)
- «Camera shutter and flash combined» — montclairguy, https://freesound.org/people/montclairguy/sounds/353044/ (в студии: Затвор и вспышка)
- «Item Sparkle» — Mr._Fritz_, https://freesound.org/people/Mr._Fritz_/sounds/545238/ (в студии: Искорка)
- «Electricity Sound» — NachtmahrTV, https://freesound.org/people/NachtmahrTV/sounds/556717/ (в студии: Электрический разряд)
- «Magic spell (small positive)» — Nakhas, https://freesound.org/people/Nakhas/sounds/506939/ (в студии: Заклинание)
- «Menu Selection Click» — NenadSimic, https://freesound.org/people/NenadSimic/sounds/171697/ (в студии: Клик меню)
- «GLEAM-GLOW-SFX-CHIME.wav» — newagesoup, https://freesound.org/people/newagesoup/sounds/351408/ (в студии: Сияние)
- «MECH-KEYBOARD-01.wav» — newagesoup, https://freesound.org/people/newagesoup/sounds/348239/ (в студии: Механическая клавиша)
- «Flicking a Switch» — njjjjjjjjjjjjjjjjjjjjjjjj, https://freesound.org/people/njjjjjjjjjjjjjjjjjjjjjjjj/sounds/566176/ (в студии: Выключатель)
- «Pop!.aif» — oldedgar, https://freesound.org/people/oldedgar/sounds/97978/ (в студии: Хлопки пузырей)
- «ding 3.wav» — organicmanpl, https://freesound.org/people/organicmanpl/sounds/149268/ (в студии: Долгий звон)
- «thud.wav» — OtisJames, https://freesound.org/people/OtisJames/sounds/215162/ (в студии: Глухой удар)
- «Click / Finger Snap» — OwlStorm, https://freesound.org/people/OwlStorm/sounds/151214/ (в студии: Щелчок пальцами)
- «Single Water Drop» — paespedro, https://freesound.org/people/paespedro/sounds/174718/ (в студии: Капля)
- «turnPage.mp3» — partheeban, https://freesound.org/people/partheeban/sounds/457767/ (в студии: Перелистывание)
- «mouse-click-double-00.flac» — pbimal, https://freesound.org/people/pbimal/sounds/534104/ (в студии: Мышка)
- «Ui sounds - Shimmering success» — Philip_Berger, https://freesound.org/people/Philip_Berger/sounds/648212/ (в студии: Мерцание)
- «Money Bag» — PhilSavlem, https://freesound.org/people/PhilSavlem/sounds/338260/ (в студии: Мешок денег)
- «Mouse Click Sound.mp3» — Pixeliota, https://freesound.org/people/Pixeliota/sounds/678248/ (в студии: Мышка)
- «Cartoon Fall» — plasterbrain, https://freesound.org/people/plasterbrain/sounds/395443/ (в студии: Мультяшное падение)
- «Cute Anime Jumps» — plasterbrain, https://freesound.org/people/plasterbrain/sounds/396196/ (в студии: Прыжок)
- «Game Start» — plasterbrain, https://freesound.org/people/plasterbrain/sounds/243020/ (в студии: Старт игры)
- «iPhone Camera Capture.wav» — pooky1, https://freesound.org/people/pooky1/sounds/431588/ (в студии: Фото на телефон)
- «swoosh.wav» — PorkMuncher, https://freesound.org/people/PorkMuncher/sounds/263595/ (в студии: Свист)
- «Dramatic Hit» — qubodup, https://freesound.org/people/qubodup/sounds/222517/ (в студии: Драматичный удар)
- «Swipe Whoosh» — qubodup, https://freesound.org/people/qubodup/sounds/60007/ (в студии: Вжух)
- «SWOSH-01 44.1kHz» — qubodup, https://freesound.org/people/qubodup/sounds/59988/ (в студии: Вжух)
- «Whoosh» — qubodup, https://freesound.org/people/qubodup/sounds/60013/ (в студии: Вжух)
- «SFX Magic» — renatalmar, https://freesound.org/people/renatalmar/sounds/264981/ (в студии: Волшебство)
- «glitch1.wav» — sandufi, https://freesound.org/people/sandufi/sounds/350614/ (в студии: Глитч)
- «Ding! idea.mp3» — Saya13, https://freesound.org/people/Saya13/sounds/407258/ (в студии: Идея!)
- «Boink_v3.wav» — simon.rue, https://freesound.org/people/simon.rue/sounds/61847/ (в студии: Боинг)
- «Data Reveal Sound» — Sky_Motion, https://freesound.org/people/Sky_Motion/sounds/511418/ (в студии: Расшифровка)
- «whip01.wav» — snowflakes, https://freesound.org/people/snowflakes/sounds/72189/ (в студии: Хлыст)
- «whip02.wav» — snowflakes, https://freesound.org/people/snowflakes/sounds/72190/ (в студии: Хлыст)
- «whip03.wav» — snowflakes, https://freesound.org/people/snowflakes/sounds/72191/ (в студии: Хлыст)
- «finger snap 02.aiff» — SoundCollectah, https://freesound.org/people/SoundCollectah/sounds/109400/ (в студии: Щелчок пальцами)
- «Riser sound effect short.wav» — syntheffects, https://freesound.org/people/syntheffects/sounds/685256/ (в студии: Нарастание шума)
- «Punch_02.wav» — thefsoundman, https://freesound.org/people/thefsoundman/sounds/118513/ (в студии: Удар кулаком)
- «negative_beeps.wav» — themusicalnomad, https://freesound.org/people/themusicalnomad/sounds/253886/ (в студии: Ошибка)
- «Sting, rimshot, drum roll (smooth)» — tlwmdbt, https://freesound.org/people/tlwmdbt/sounds/440829/ (в студии: Ба-дум-тсс)
- «Double_Zipper_fast.aif» — tmkappelt, https://freesound.org/people/tmkappelt/sounds/85679/ (в студии: Молния)
- «Scribble» — Tomoyo Ichijouji, https://freesound.org/people/Tomoyo Ichijouji/sounds/211247/ (в студии: Карандаш)
- «desk bell center.mp3» — tonmayster, https://freesound.org/people/tonmayster/sounds/685111/ (в студии: Звонок на стойке)
- «Keyboard Typing» — Trollarch2, https://freesound.org/people/Trollarch2/sounds/331656/ (в студии: Офисная клавиатура)
- «FX swanee whistle up.wav» — v0idation, https://freesound.org/people/v0idation/sounds/497092/ (в студии: Свисток вверх)
- «Single Finger Snap» — vckhaze, https://freesound.org/people/vckhaze/sounds/332604/ (в студии: Щелчок пальцами)
- «Scribble_short.wav» — waldram, https://freesound.org/people/waldram/sounds/257518/ (в студии: Карандаш)
- «[Perc] Short Click/Snap Perc» — waveplaySFX, https://freesound.org/people/waveplaySFX/sounds/399934/ (в студии: Перкуссия)
- «Vintage Camera Flash Powder and Shutter» — Werra, https://freesound.org/people/Werra/sounds/232130/ (в студии: Вспышка)
- «3 Popping Pops» — wubitog, https://freesound.org/people/wubitog/sounds/188381/ (в студии: Хлопки пузырей)
- «Notification Sound» — yfjesse, https://freesound.org/people/yfjesse/sounds/235911/ (в студии: Уведомление)
- «Cash Register Purchase» — Zott820, https://freesound.org/people/Zott820/sounds/209578/ (в студии: Касса)

The keyboard banks in `../sounds/keys/` are the owner's own downloads with an
unknown licence; the studio marks them «лицензия?».
