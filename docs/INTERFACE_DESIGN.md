# Screening-room interface

The interface keeps TachyonStream's library, room playback, upload flow, and section order. No generated artwork or replacement film covers are used.

## Direction

- Product: a personal film library for watching together.
- Character: composed, clear, focused.
- World: a screening room, with graphite surfaces, off-white type, and restrained red selection marks.
- Moments: the actual film covers and video frames carry the color.
- Signature: a short, static room-status mark.

## Nine passes

1. Spacing: grouped controls on a 4px rhythm; 44px mobile targets; consistent card padding.
2. Color: graphite surfaces and three text roles; removed colored gradients, glows, and chrome blur.
3. Icons: kept the existing SVG family with a consistent line weight and control sizing.
4. Copy: shorter library/upload labels and sentence-case playback status.
5. Type: retained Plus Jakarta Sans with weights 400–600, readable metadata, and tabular time values.
6. Layout: primary and secondary hero actions separated from playback utilities; empty video dock hidden until media is selected; mobile cards and navigation reflow without hiding features.
7. Details: restrained counts, 8px controls, visible focus, stable card actions, preserved menu layering.
8. Visuals: retained the product's real imagery; no filler scene or generated image.
9. Motion: removed looping decoration, hover movement, image zoom, and width transitions; kept short interaction feedback and reduced-motion support.

Design workflow adapted from **unslop** by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Original: https://heydamir.design/unslop

## Verification

Existing regression checks passed. Chromium checks cover card menus, Escape, Library/Upload navigation, and a 390px viewport with 44px visible navigation/card targets and no page-level horizontal overflow. Screenshots are local review artifacts, not bundled film content. No backend behavior or video files were changed by this design pass. Physical phones, Safari, and the deployed public domain have not been verified.

## Playback control

The hero transport uses an Apple TV-inspired capsule. Its action changes between Play and Pause, with a separate Playing/Paused status. The label, icon, and accessible name follow video play/pause events, including room-driven playback, and reset when media ends or is cleared. Chromium playback checks verified both states against the actual video element.

## Unobstructed Cinema

The Cinema canvas fills the viewport while site navigation is hidden. Neutral transparent scrims and a compact floating transport replace solid full-width panels. Idle controls become inert to avoid invisible focus targets. Paused playback, keyboard focus, seeking, and episode browsing retain access to controls. Touch and Tab restore the HUD. Video remains object-fit: contain.
