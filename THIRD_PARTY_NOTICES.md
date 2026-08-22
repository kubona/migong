# Third-party notices

## MWICombatSimulatorTest

This project includes locally cached JavaScript bundles from:

- https://shykai.github.io/MWICombatSimulatorTest/dist/
- https://github.com/shykai/MWICombatSimulatorTest (fork of `AmVoidGuy/MWICombatSimulatorTest`)

Files retrieved for local offline execution:

- `src_worker_js.bundle.js` — SHA-256 `D602EA7B15DAAD2965F58A6CF69E00A7217E60159D7E39DA995664529C399E50`
- `vendors-heap.bundle.js` — SHA-256 `C9DEAB4CF7D2ABEACB0A1103E3DD705B5E1E8DD277E8227FBC67FE51D9380AF5`

The upstream repository is distributed under the MIT License:

> MIT License
>
> Copyright (c) 2024 AmVoidGuy
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Milky Way Idle data, names and item icons

Game names, mechanics, artwork and user-supplied catalog data belong to their respective owners. This software does not bundle the user's `init_client_data` or `init_character_data`; users load their own local copies at runtime.

`app/assets/items_sprite.f58c9476.svg` is a locally cached Milky Way Idle web-client item icon sprite used only for the on-screen loadout chart and self-contained SVG loadout export. SHA-256: `839A27308B8C9D8D981AE338DFD583E560D3EB19AA53AAFD2C994DCF09A9B85B`.

## c3d-gg/mwi-types Chinese localization

`app/data/zh.json` is sourced from the MIT-licensed `c3d-gg/mwi-types` project:

- https://github.com/c3d-gg/mwi-types
- Source path: `src/sources/locales/zh.json`
- The upstream license is bundled as `app/data/c3d-mwi-types-LICENSE.txt`.

The bundled JSON is minimized to the eight name dictionaries used by the simulator and contains no account, chat, authentication, announcement, or external-link content. Minimized file SHA-256: `1B0444861D8185A3CA93D2FBC4ECC36C88241A0A579D312D20A8F0F8C6B0A1B0`.

Small local overrides cover newer labyrinth item and monster names that are not present in the upstream localization snapshot.
