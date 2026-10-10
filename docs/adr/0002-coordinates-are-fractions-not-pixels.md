# Coordinates are fractions, not pixels

Target boxes are stored as fractions of the picture's width and height (0–1), and a click is converted to the same form by dividing by the image's `getBoundingClientRect()`. No pixel value ever crosses the wire or reaches the database.

The Odin assignment warns that pixel coordinates recorded on a large screen resolve to the wrong place on a small one. Normalising at the click site makes that class of bug impossible rather than handled, and it means the same box works at any rendered size — a phone and a 4K monitor read the identical number.

The temptation to store pixels was rejected: it would make authoring boxes easier, but then every box silently encodes the dimensions of the image it was measured against, and any future change to how the picture is rendered breaks every stored box. Fractions cost one division on the way in and nothing on the way out.