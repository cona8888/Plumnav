"""Independent global-integral FOH response reconstruction, no engine imports."""
import math
import numpy as np


def response(y,u,m,tau,h):
    # Independent power-series evaluation in the small-interval regime.
    z=h/tau
    if z<.1:
        e1=0.;e2=0.;e3=0.;term=z
        for k in range(1,17):
            e1+=term;e2+=term*z/(k+1);e3+=term*z*z/((k+1)*(k+2));term*=-z/(k+1)
        return y+(u-y)*e1+m*tau*e2, y*h+(u-y)*tau*e2+m*tau*tau*e3
    q=math.exp(-z);v=u+m*(h-tau)+(y-u+m*tau)*q
    integral=u*h+m*(h*h/2-tau*h)+(y-u+m*tau)*tau*(-math.expm1(-z))
    return v,integral


def advance(y,u,m,rise,recovery,h):
    tau=rise if u>y or (u==y and m>=0) else recovery
    d=u-y
    crossing=tau*math.log1p(-d/(m*tau)) if d*m<0 else math.inf
    if crossing<h:
        _,area=response(y,u,m,tau,crossing);at=u+m*crossing
        v,rest=response(at,at,m,rise if m>=0 else recovery,h-crossing)
        return v,area+rest
    return response(y,u,m,tau,h)


def filtered_history(times,inputs,settings):
    times=np.asarray(times);inputs=np.asarray(inputs);step=float(times[1]-times[0]);window=settings['averagingSeconds'];ticks=round(window/step)
    assert times[0]==0 and np.max(abs(np.diff(times)-step))<1e-12 and abs(ticks*step-window)<1e-12
    assert inputs.shape==(len(times),4) and np.isfinite(inputs).all() and np.min(inputs)>=0
    delay=math.pi*(settings['tubeInnerDiameterMetres']/2)**2*settings['tubeLengthMetres']/(settings['flowLitresPerMinutePerChannel']/60000)
    due=times+delay;integrals=np.zeros_like(inputs);states=np.zeros_like(inputs)
    rise=settings['riseTimeConstantSeconds'];recovery=settings['recoveryTimeConstantSeconds']
    for ch in range(4):
        clock=0.;state=0.;total=0.;event=0
        for i,t in enumerate(times):
            while clock<t:
                while event+1<len(due) and due[event+1]<=clock:event+=1
                if clock<due[0]:end=min(t,due[0]);u=0.;m=0.
                else:
                    assert event+1<=i,('future endpoint',event,i)
                    end=min(t,due[event+1]);m=(inputs[event+1,ch]-inputs[event,ch])/(due[event+1]-due[event]);u=inputs[event,ch]+m*(clock-due[event])
                state,area=advance(state,u,m,rise,recovery,end-clock);total+=area;clock=end
            integrals[i,ch]=total;states[i,ch]=state
    if window==0:return states
    prior=np.zeros_like(inputs)
    if ticks<len(times):prior[ticks:]=integrals[:-ticks]
    return (integrals-prior)/window
