-- The six characters in the Robot City picture, verified against the 1920x3858
-- artwork. Boxes are fractions of the picture's width and height and are
-- slightly generous, so a near miss on a small character is forgiven rather
-- than punishing. Re-running this updates a box by name instead of adding a
-- second row for the same character.

INSERT INTO targets (name, x, y, w, h) VALUES
  ('Wanda, the pink dancer',   0.495, 0.002, 0.090, 0.093),
  ('Spike, the shark',         0.140, 0.170, 0.075, 0.085),
  ('Diablo, the red devil',    0.855, 0.245, 0.125, 0.130),
  ('Lemkin, the yellow creature', 0.460, 0.540, 0.065, 0.065),
  ('Vince, the detective',     0.288, 0.152, 0.075, 0.062),
  ('Boris, the blue hologram', 0.560, 0.680, 0.100, 0.100)
ON CONFLICT (name) DO UPDATE SET
  x = EXCLUDED.x,
  y = EXCLUDED.y,
  w = EXCLUDED.w,
  h = EXCLUDED.h;
