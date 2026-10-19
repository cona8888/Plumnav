"""Independent age-segmented reference; no forward-engine imports or tail cutoffs."""
import math
from scipy.integrate import quad


def parts(row,field,age):
    source=field['source'];u=field['wind']['x'];d=field['diffusivity'];sigma=field['sigma']
    if not age>0 or not u>0 or not d>0 or not sigma>0:
        raise ValueError('Reference requires positive age, wind, diffusivity and source sigma')
    x,y,z=row['x']-source['x'],row['y']-source['y'],row['z']
    def kernel(a):
        var=sigma*sigma+2*d*a
        h=math.exp(-((x-u*a)**2+y*y)/(2*var))
        vertical=math.exp(-(z-source['z'])**2/(2*var))+math.exp(-(z+source['z'])**2/(2*var))
        return field['rateKgPerSecond']*h*vertical/(2*math.pi*var)**1.5
    scale=min(sigma*sigma/(2*d),sigma/u)
    edges={0.,float(age)};edge=scale
    while edge<age:
        edges.add(edge);edge*=2
    centre=max(0.,min(age,x/u));width=math.sqrt(sigma*sigma+2*d*centre)/u
    edges.update(p for k in [-8,-4,-2,-1,0,1,2,4,8] if 0<(p:=centre+k*width)<age)
    return kernel,scale,sorted(edges)


def independent_concentration(row,field,age):
    kernel,_,edges=parts(row,field,age)
    values=[quad(kernel,lo,hi,epsabs=1e-16,epsrel=1e-10,limit=100) for lo,hi in zip(edges,edges[1:])]
    value=math.fsum(v for v,_ in values);error=math.fsum(e for _,e in values)
    if not math.isfinite(value) or not math.isfinite(error) or error>max(1e-13,abs(value)*1e-6):
        raise ValueError('Segmented independent quadrature uncertainty too high')
    return value*(1e6*8.314462618*298.15/(101325*.01604))


def log_age_reference(row,field,age):
    kernel,scale,edges=parts(row,field,age)
    # Independently change the integration variable; integrate the bounded log
    # domain in a single adaptive call, supplying transformed peak landmarks.
    def transformed(s):
        a=scale*math.expm1(s)
        return kernel(a)*scale*math.exp(s)
    hi=math.log1p(age/scale)
    values=quad(transformed,0,hi,points=[math.log1p(e/scale) for e in edges[1:-1]],
                epsabs=1e-16,epsrel=1e-11,limit=500)
    if values[1]>max(1e-13,abs(values[0])*1e-6):raise ValueError('Log-age reference uncertainty')
    return values[0]*(1e6*8.314462618*298.15/(101325*.01604))
