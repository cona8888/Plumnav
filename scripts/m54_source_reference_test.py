import unittest
from math import inf
from m54_source_reference import Release, pulse, cell_mass, continuous


class ReferenceTests(unittest.TestCase):
    def test_total_halfspace_mass_including_ground_source(self):
        for height in (0, 0.025, 0.2):
            for age in (0, 0.1, 1):
                self.assertAlmostEqual(cell_mass(((-inf, inf), (-inf, inf), (0, inf)), age,
                                                3.7, Release(source=(0, 0, height))), 3.7, places=13)

    def test_cell_partition_is_conservative(self):
        whole = cell_mass(((-1, 1), (-1, 1), (0, 1)), 0.2)
        parts = sum(cell_mass(((a, b), (-1, 1), (0, 1)), 0.2)
                    for a, b in ((-1, -0.1), (-0.1, 0.3), (0.3, 1)))
        self.assertAlmostEqual(whole, parts, places=14)

    def test_no_flux_wall_second_order_one_sided_derivative(self):
        h = 1e-6
        f = lambda z: pulse((0.1, 0.03, z), 0.2)
        derivative = (-3*f(0)+4*f(h)-f(2*h))/(2*h)
        self.assertLess(abs(derivative), 1e-5)

    def test_advection_diffusion_pde_residual(self):
        r = Release()
        p, t, h = (0.13, 0.07, 0.09), 0.2, 1e-5
        f = lambda q, age=t: pulse(q, age, release=r)
        dt = (f(p, t+h)-f(p, t-h))/(2*h)
        gradient, laplacian = [], 0
        for axis in range(3):
            plus, minus = list(p), list(p)
            plus[axis] += h
            minus[axis] -= h
            gradient.append((f(plus)-f(minus))/(2*h))
            laplacian += (f(plus)-2*f(p)+f(minus))/h**2
        residual = dt + r.wind[0]*gradient[0] + r.wind[1]*gradient[1] - r.diffusivity*laplacian
        self.assertLess(abs(residual)/max(1, abs(dt), abs(r.diffusivity*laplacian)), 1e-5)

    def test_dimensional_scaling(self):
        length, time, mass = 100, 20, 7
        r = Release()
        scaled = Release(r.diffusivity*length**2/time,
                         tuple(u*length/time for u in r.wind),
                         tuple(x*length for x in r.source), r.sigma*length)
        p = (0.1, 0.03, 0.05)
        reference = pulse(p, 0.2)
        dimensional = pulse(tuple(x*length for x in p), 0.2*time, mass, scaled)
        self.assertAlmostEqual(dimensional*length**3/mass, reference, places=11)

    def test_zero_release_and_quadrature_refinement(self):
        p = (0.1, 0.03, 0.05)
        self.assertEqual(pulse(p, 0.2, 0), 0)
        self.assertEqual(continuous(p, 0.2, rate=0), 0)
        a, b, c = [continuous(p, 0.2, panels=n) for n in (128, 256, 512)]
        self.assertLess(abs(b-c), abs(a-b)/3.5)
        self.assertAlmostEqual(continuous(p, 0.2, rate=2), 2*continuous(p, 0.2), places=12)
        self.assertLess(continuous(p, 0.2, stop=0.1), continuous(p, 0.2))

    def test_invalid_parameters_rejected(self):
        for kwargs in ({"diffusivity": -1}, {"sigma": 0}, {"source": (0, 0, -1)}):
            with self.assertRaises(ValueError):
                Release(**kwargs)
        with self.assertRaises(ValueError):
            pulse((0, 0, -0.1), 0.2)


if __name__ == "__main__":
    unittest.main()
