# Draw_plasma_density

Open `index.html` in a browser to use the plotter.

Run the regression tests with Node.js 18 or newer (no npm dependencies):

```sh
node --test tests/profile.test.cjs
```

Tests execute the JavaScript from `index.html`, compare the analytic areal density
with numerical integration, and check nonzero results against fixtures captured
before the zero-density fix. They cover both ramp switches, linear ramps and both
exponential constraints, zero/nonzero edge densities, and the NPZ export boundary.

Areal density is integrated directly from each segment's endpoint densities.
At zero plateau density, plateau-normalized area factors are undefined and shown
as a dash. Equivalent-area exponential constraints also require a nonzero plateau;
at zero plateau they fall back to linear, with an explanatory status message.
Valid critical-density distance constraints still determine exponential shapes.

NPZ export refuses nonfinite profile coordinates, densities or areal density.
`crossings_nc_um.npy` retains its existing NaN convention for absent crossings;
these are missing-value markers, not invalid density data.
