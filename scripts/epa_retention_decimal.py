"""Independent exact-decimal percentile/classification; no rational code import."""
from decimal import Decimal,localcontext,Inexact,Rounded

def decimal_reference(texts,cutoff):
    assert texts
    values=[Decimal(t) for t in texts];threshold=Decimal(cutoff)
    assert all(v.is_finite() for v in values+[threshold])
    nonzero=[v for v in values+[threshold] if v]
    tuples=[v.as_tuple() for v in values+[threshold]]
    # Span plus significant digits and index-arithmetic margin covers exact
    # products/differences and division by 20; any overlooked rounding fails.
    digits=max(len(t.digits) for t in tuples)
    span=max((v.adjusted() for v in nonzero),default=0)-min((t.exponent for t in tuples),default=0)
    precision=max(64,digits+max(0,span)+len(str(len(values)))+32)
    assert precision<=4096
    with localcontext() as context:
        context.prec=precision;context.traps[Inexact]=True;context.traps[Rounded]=True
        ordered=sorted(values);index,remainder=divmod(len(values)-1,20)
        background=((20-remainder)*ordered[index]+remainder*ordered[min(index+1,len(values)-1)])/20
        selected=[i for i,value in enumerate(values) if value-background>=threshold]
        text=str(background)
    return text,selected,precision
